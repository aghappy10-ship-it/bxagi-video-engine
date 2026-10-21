import { handleBxagiAuthRequest, resolveBxagiContext, resolveBxagiContextForUser, clearBxagiCookie, invalidateBxagiContext, BXAGI_SESSION_COOKIE, probeBxagiConnection } from './bxagi-auth.mjs';
import { createBxagiOrchestrator, syncDueBxagiJobs, isCollectableBxagiProductionJob } from './bxagi-orchestrator.mjs';
import { createPlatformRepository } from './platform-repository.mjs';
import { createAutomaticFlow, describeAutomaticFlow } from './automatic-flow.mjs';
import { employeeProfiles, inferScene, selectProductionEmployee, selectBuyingEmployee, capabilityCatalog } from '../shared/employees.mjs';
import { buildCreativePlan } from '../shared/creative-engine.mjs';
import { createAdsService, connectionSummary, encryptConnectionSecrets } from './ads-service.mjs';
import { createBxagiButler } from './bxagi-butler.mjs';
import { backgroundSchedulerHealth, runBackgroundTick, schedulerAuthorized } from './background-scheduler.mjs';
import { createBxagiNodeHealth } from './bxagi-node-health.mjs';
import { assertCreativeDeliveryComplete } from './creative-delivery-eligibility.mjs';
import { json, fail, requireRow, string, listStrings, positive, containsSecretKey, parseJson } from './platform/protocol.mjs';
import { putUpload } from './platform/uploads.mjs';
import { publicFile, contentResponse } from './platform/downloads.mjs';
import { metricDecision } from './platform/metrics.mjs';
import { createProductionService } from './production-service.mjs';
import { withDeliveryGroupLock, assertDeliveryGroupAllocation } from './delivery-groups.mjs';
import { handleBusinessRoutes } from './platform/business-routes.mjs';
import { executeCampaignAction } from './platform/campaign-actions.mjs';
import { createCatalogService } from './catalog-service.mjs';

const OBJECTIVES = ['purchase', 'install', 'lead', 'views'];
const CHANNELS = ['oceanengine', 'kuaishou', 'tencent', 'custom'];
const CONNECTION_PROVIDERS = [...CHANNELS, 'volcano'];
const customDefinitions = rows => rows.map(r => ({
  ...r.definition,
  id: r.id,
  name: r.name,
  role: r.role,
  scene: r.scene,
  userId: r.userId
}));

export async function handlePlatformRequest(request, env = {}, injected = {}) {
  let activeBxagiContext;
  try {
    const path = new URL(request.url).pathname.replace(/^\/api\/v2/, '').replace(/\/$/, '') || '/';
    const method = request.method;
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && !path.startsWith('/worker/')) {
      const origin = request.headers.get('Origin');
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || origin && origin !== new URL(request.url).origin) {
        fail(403, '请在本工作区页面发起操作', 'cross_site_request');
      }
    }
    if (path === '/system/health' && method === 'GET') {
      const backgroundScheduler = await backgroundSchedulerHealth(env);
      const bxagi = {
        required: env.BXAGI_REQUIRED === true || env.BXAGI_REQUIRED === 'true',
        protocolVerified: true,
        liveVerified: false,
        sessionEncryptionConfigured: !!env.APP_ENCRYPTION_KEY
      };
      // Fixed official anonymous endpoint only; this never signs in or uses stored credentials.
      if (new URL(request.url).searchParams.get('probeBxagi') === 'true') {
        bxagi.connection = await probeBxagiConnection({
          env,
          fetcher: injected.fetcher
        });
      }
      return json({
        version: '2.2.0',
        storage: !!env.BUCKET,
        database: !!env.DB,
        modelConfigured: env.BXAGI_BUTLER_ENABLED === 'true' || env.BXAGI_PLANNER_ENABLED === 'true',
        plannerMode: env.BXAGI_BUTLER_ENABLED === 'true' ? 'official_butler' : env.BXAGI_PLANNER_ENABLED === 'true' ? 'bxagi_employee' : 'rules',
        workerConfigured: !!env.APP_WORKER_SECRET,
        credentialsEncryptionConfigured: !!env.APP_ENCRYPTION_KEY,
        backgroundScheduling: backgroundScheduler.status === 'running',
        backgroundSchedulingConfigured: backgroundScheduler.configured,
        backgroundScheduler,
        bxagi
      });
    }
    if (path.startsWith('/bxagi/auth/')) {
      return handleBxagiAuthRequest(request, env, {
        fetcher: injected.fetcher
      });
    }
    if (['/worker/node-inspection', '/worker/automation-probe', '/worker/market-inspection', '/worker/production-inspection', '/worker/production-collection', '/worker/production-repair', '/worker/production-visual-repair', '/worker/production-video-format-repair', '/worker/production-showcase-layout-repair', '/worker/production-artifact', '/worker/production-original', '/worker/butler-diagnostic', '/worker/butler-inspection', '/worker/butler-bootstrap'].includes(path)) {
      const {
        handleAutomationProbe
      } = await import('./automation-probe.mjs');
      return handleAutomationProbe(request, env, {
        fetcher: injected.fetcher
      });
    }
    if (path === '/worker/background-tick') {
      if (method !== 'POST') {
        fail(405, '后台调度需要POST请求', 'method_not_allowed');
      }
      if (new URL(request.url).search) {
        fail(400, '后台调度不接受参数', 'background_parameters_refused');
      }
      if (!(await schedulerAuthorized(request, env))) {
        fail(401, '后台调度认证失败', 'worker_unauthorized');
      }
      // No account, project, action or prompt can be supplied by the caller.
      if (request.body) {
        const reader = request.body.getReader();
        let size = 0;
        const chunks = [];
        while (true) {
          const part = await reader.read();
          if (part.done) {
            break;
          }
          size += part.value.length;
          if (size > 16) {
            await reader.cancel();
            fail(400, '后台调度不接受参数', 'background_parameters_refused');
          }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const body = new TextDecoder().decode(bytes).trim();
        if (body && body !== '{}') {
          fail(400, '后台调度不接受参数', 'background_parameters_refused');
        }
      }
      const repository = injected.repository ?? createPlatformRepository(env.DB);
      const ads = injected.adsService ?? createAdsService({
        repository,
        bucket: env.BUCKET,
        env,
        fetcher: injected.fetcher
      });
      const contexts = new Map();
      const resolve = async (owner, _env, options) => {
        if (!contexts.has(owner)) {
          contexts.set(owner, (async () => {
            const context = await (injected.resolveBxagiContextForUser || resolveBxagiContextForUser)(owner, env, options);
            if (context && context.userId === owner && context.subject) {
              await createBxagiNodeHealth({
                repository,
                context,
                fetcher: injected.fetcher
              }).inspect();
            }
            return context;
          })());
        }
        return contexts.get(owner);
      };
      return json(await runBackgroundTick({
        env,
        work: injected.backgroundWork || (async () => {
          const outcomes = await Promise.allSettled([ads.tick(), (async () => {
            const automation = await createAutomaticFlow({
              repository,
              bucket: env.BUCKET,
              env,
              fetcher: injected.fetcher,
              adsService: ads,
              resolveContext: resolve
            }).tick({
              limit: 1
            });
            const legacy = await syncDueBxagiJobs({
              repository,
              bucket: env.BUCKET,
              env,
              fetcher: injected.fetcher,
              adsService: ads,
              resolveContext: resolve
            });
            return {
              processed: automation.processed + legacy.processed
            };
          })(), createCatalogService({
            env,
            fetcher: injected.fetcher,
            repository
          }).tick({ limit: 20 })]);
          if (outcomes.some(row => row.status === 'rejected')) {
            throw new Error('background_tick_incomplete');
          }
          return {
            processed: outcomes.reduce((sum, row) => sum + (Number(row.value?.processed) || 0), 0)
          };
        })
      }));
    }
    if (path.startsWith('/worker/')) {
      const repository = injected.repository ?? createPlatformRepository(env.DB);
      const ads = injected.adsService ?? createAdsService({
        repository,
        bucket: env.BUCKET,
        env,
        fetcher: injected.fetcher
      });
      if (!['/worker/tick', '/worker/bxagi-tick'].includes(path)) {
        const {
          handleWorkerRequest
        } = await import('./worker-api.mjs');
        return handleWorkerRequest(request, {
          repository,
          bucket: env.BUCKET,
          env
        });
      }
      if (method !== 'POST') {
        fail(405, '后台接口需要POST请求', 'method_not_allowed');
      }
      if (!env.APP_WORKER_SECRET) {
        fail(503, '后台员工密钥未配置', 'worker_unavailable');
      }
      if (request.headers.get('Authorization') !== `Bearer ${env.APP_WORKER_SECRET}`) {
        fail(401, '后台员工认证失败', 'worker_unauthorized');
      }
      if (path === '/worker/tick') {
        return json(await ads.tick());
      }
      const automation = await createAutomaticFlow({
        repository,
        bucket: env.BUCKET,
        env,
        fetcher: injected.fetcher,
        adsService: ads
      }).tick();
      const legacy = await syncDueBxagiJobs({
        repository,
        bucket: env.BUCKET,
        env,
        fetcher: injected.fetcher,
        adsService: ads,
        resolveContext: resolveBxagiContextForUser
      });
      return json({
        ...legacy,
        automation
      });
    }
    // Only a server-verified BXAGI session selects the tenant. Hosting identity
    // headers and request body user IDs never supply application authority.
    const resolveContext = injected.resolveBxagiContext ?? resolveBxagiContext;
    const authenticated = await resolveContext(request, env, {
      fetcher: injected.fetcher,
      required: true
    });
    const userId = authenticated?.userId || authenticated?.nativeUserId;
    if (typeof userId !== 'string' || !userId || userId.length > 256) {
      fail(401, '请登录BXAGI账号', 'bxagi_login_required');
    }
    if (path === '/bxagi/nodes/state') {
      if (method !== 'GET') {
        return json({
          error: {
            code: 'method_not_allowed',
            message: '节点状态仅支持读取'
          }
        }, 405, {
          Allow: 'GET'
        });
      }
      if (new URL(request.url).search) {
        fail(400, '节点状态仅检查当前账号', 'bxagi_node_parameters_refused');
      }
      const service = (injected.createNodeHealth || createBxagiNodeHealth)({
        repository: injected.repository ?? createPlatformRepository(env.DB),
        context: authenticated,
        fetcher: injected.fetcher
      });
      return json(await service.inspect());
    }
    if (path === '/bxagi/butler/initialize') {
      if (method !== 'POST') {
        return json({
          error: {
            code: 'method_not_allowed',
            message: '初始化需要POST请求'
          }
        }, 405, {
          Allow: 'POST'
        });
      }
      if (new URL(request.url).search || (await request.text())) {
        fail(400, '初始化仅使用当前登录账号', 'bxagi_butler_parameters_refused');
      }
      activeBxagiContext = authenticated;
      const {
        createBxagiButlerBootstrap
      } = await import('./bxagi-butler-bootstrap.mjs');
      const repo = injected.repository ?? createPlatformRepository(env.DB);
      const service = (injected.createButlerBootstrap || createBxagiButlerBootstrap)({
        repository: repo,
        context: authenticated,
        fetcher: injected.fetcher
      });
      return json({
        bootstrap: await service.ensure({
          authorizationExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }),
        checkedAt: new Date().toISOString()
      });
    }
    if (path === '/bxagi/butler/state') {
      if (method !== 'GET') {
        return json({
          error: {
            code: 'bxagi_butler_read_only',
            message: '大管家状态仅支持读取'
          }
        }, 405, {
          Allow: 'GET'
        });
      }
      if (new URL(request.url).search) {
        fail(400, '大管家状态使用当前登录账号和固定记录范围', 'bxagi_butler_parameters_refused');
      }
      activeBxagiContext = authenticated;
      const butler = createBxagiButler({
        accessToken: authenticated.accessToken,
        subject: authenticated.subject,
        fetcher: injected.fetcher,
        timeoutMs: 5000
      });
      const results = await Promise.allSettled([butler.inspectCapabilities(), butler.listDispatches({
        limit: 10,
        offset: 0
      })]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) {
        throw (failures.find(result => result.reason?.status === 401) || failures[0]).reason;
      }
      const capabilities = results[0].value,
        dispatches = results[1].value;
      let readiness;
      try {
        const {
          createBxagiButlerBootstrap
        } = await import('./bxagi-butler-bootstrap.mjs');
        readiness = await (injected.createButlerBootstrap || createBxagiButlerBootstrap)({
          repository: injected.repository ?? createPlatformRepository(env.DB),
          context: authenticated,
          fetcher: injected.fetcher
        }).inspect();
      } catch {
        readiness = {
          status: 'unavailable',
          reason: 'butler_readiness_unavailable',
          ownershipVerified: false
        };
      }
      return json({
        provider: 'bxagi',
        readOnly: true,
        capabilities,
        readiness,
        schedulingEnabled: env.BXAGI_BUTLER_ENABLED === 'true',
        dispatches: {
          ...dispatches,
          returnedCount: dispatches.items.length
        },
        dispatchExecutionVerified: false,
        executionStatus: readiness.status === 'ready' ? 'ready' : 'unverified',
        checkedAt: new Date().toISOString()
      });
    }
    const displayName = authenticated.profile?.displayName || authenticated.profile?.username || 'BXAGI用户';
    const repository = injected.repository ?? createPlatformRepository(env.DB);
    const ads = injected.adsService ?? createAdsService({
      repository,
      bucket: env.BUCKET,
      env,
      fetcher: injected.fetcher
    });
    const bxagiRequired = env.BXAGI_REQUIRED === true || env.BXAGI_REQUIRED === 'true';
    const hasBxagiCookie = (request.headers.get('Cookie') || '').split(';').some(c => c.trim().startsWith(`${BXAGI_SESSION_COOKIE}=`));
    const remoteMode = bxagiRequired || hasBxagiCookie;
    const bxagiContext = async (required = bxagiRequired) => required ? authenticated : resolveContext(request, env, {
      fetcher: injected.fetcher,
      required: false
    });
    const workforceFor = context => {
      activeBxagiContext = context;
      return createBxagiOrchestrator({
        repository,
        bucket: env.BUCKET,
        env,
        context,
        fetcher: injected.fetcher,
        adsService: ads,
        workforce: injected.bxagiWorkforce
      });
    };
    const remoteWorkflow = async () => {
      const context = await bxagiContext(bxagiRequired);
      return context ? workforceFor(context) : null;
    };
    const automatic = () => createAutomaticFlow({
      repository,
      bucket: env.BUCKET,
      env,
      fetcher: injected.fetcher,
      adsService: ads,
      createOrchestrator: options => createBxagiOrchestrator({
        ...options,
        adsService: ads,
        workforce: injected.bxagiWorkforce
      })
    });
    if (path === '/automation/tick' && method === 'POST') {
      if (!remoteMode) {
        fail(409, '自动调度需要已连接的BXAGI账户', 'bxagi_login_required');
      }
      activeBxagiContext = authenticated;
      // Adopt existing uploaded projects once. Subsequent polls do not change
      // source versions, reset waiting states, or re-submit completed work.
      const [projects, assets, jobs] = await Promise.all([repository.listProjects(userId), repository.listAssets(userId), repository.listJobs(userId)]);
      const existing = new Set(jobs.filter(j => j.type === 'platform_automation').map(j => j.projectId));
      const excluded = new Set(assets.filter(a => a.metadata?.flowTestRunId || a.metadata?.automationProbeExpiresAt).map(a => a.projectId));
      const withAssets = new Set(assets.filter(a => !excluded.has(a.projectId)).map(a => a.projectId));
      for (const project of projects.filter(p => withAssets.has(p.id) && !existing.has(p.id) && (!p.sourceState?.version || p.sourceState.startedJobId)).slice(0, 3)) {
        await automatic().ensureProject(authenticated, project.id);
      }
      return json(await automatic().tick({
        context: authenticated,
        limit: 3
      }));
    }
    const businessResponse = await handleBusinessRoutes(request, {path,method,userId,repository,env,authenticated,remoteWorkflow,automatic,ads,fetcher:injected.fetcher});
    if (businessResponse) return businessResponse;
    const profileRows = await repository.listEmployeeProfiles(userId);
    const customProfiles = customDefinitions(profileRows);
    const classify = async project => {
      const assets = await repository.listAssets(userId, project.id);
      const inference = inferScene({
        title: `${project.title} ${project.productName}`,
        description: project.description,
        facts: project.facts,
        filenames: assets.map(a => a.filename),
        mimeTypes: assets.map(a => a.mimeType),
        customProfiles
      });
      const productionEmployee = selectProductionEmployee({
        scene: inference.scene,
        objective: project.objective,
        channel: 'custom'
      }, customProfiles);
      const assignment = remoteMode ? {
        ...inference,
        provider: 'bxagi',
        routingStatus: 'awaiting_bxagi_catalog',
        productionEmployeeId: project.productionEmployeeId?.startsWith('bxagi:') ? project.productionEmployeeId : '',
        basis: [...inference.basis, '场景判断使用项目元数据；实际员工将在BXAGI已雇佣目录中安排']
      } : {
        ...inference,
        provider: 'local',
        productionEmployeeId: productionEmployee.id,
        productionEmployee
      };
      return repository.updateProject(userId, project.id, {
        scene: inference.scene,
        productionEmployeeId: assignment.productionEmployeeId,
        assignment
      });
    };
    if (path === '/bootstrap' && method === 'GET') {
      const backgroundScheduler = await backgroundSchedulerHealth(env);
      const [projects, assets, creatives, campaigns, connections, metrics, jobs, optimizationTasks] = await Promise.all([repository.listProjects(userId), repository.listAssets(userId), repository.listCreatives(userId), repository.listCampaigns(userId), repository.listConnections(userId), repository.listMetrics(userId), repository.listJobs(userId), repository.listOptimizationTasks(userId)]);
      const [deliveryGroups,preferences,decisions,strategies,audit] = await Promise.all([repository.listDeliveryGroups?.(userId) ?? [],repository.getPreferences?.(userId) ?? null,repository.listDecisions?.(userId) ?? [],repository.listStrategies?.(userId) ?? [],repository.listAudit?.(userId) ?? []]);
      let bxagi = {
          connected: false,
          profile: null,
          status: bxagiRequired ? 'login_required' : 'not_connected',
          protocolVerified: true,
          liveVerified: false
        },
        employees = remoteMode ? [] : [...employeeProfiles, ...customProfiles],
        cookie;
      try {
        const context = await bxagiContext(false);
        if (context) {
          bxagi = {
            ...bxagi,
            connected: true,
            profile: context.profile,
            status: 'connected'
          };
          employees = await workforceFor(context).catalog();
        }
      } catch (error) {
        if (error.status === 401) {
          if (activeBxagiContext) {
            await invalidateBxagiContext(activeBxagiContext, env);
          }
          return json({
            connected: false,
            error: {
              code: error.code || 'bxagi_session_invalid',
              message: 'BXAGI会话已失效，请重新登录'
            }
          }, 401, {
            'Set-Cookie': clearBxagiCookie()
          });
        }
        employees = [];
        bxagi = {
          ...bxagi,
          status: 'unavailable',
          error: {
            code: error.code || 'bxagi_unavailable',
            message: error.status && error.status < 500 ? error.message : 'BXAGI暂不可用，请检查账户连接后重试'
          }
        };
        if (error.clearCookie) {
          cookie = clearBxagiCookie();
        }
      }
      const publicJobs = jobs.filter(job => !['bxagi_node_health', 'release_batch'].includes(job.type)).map(job => {
        const details = {
          ...job.details
        };
        delete details.operationId;
        delete details.operationExpiresAt;
        return {
          ...job,
          details
        };
      });
      return json({
        user: {
          id: userId,
          displayName: preferences?.displayName || displayName
        },
        deliveryGroups: deliveryGroups.map(({operationId,...group})=>group), preferences, decisions, strategies, audit,
        bxagi,
        projects,
        assets: assets.map(publicFile),
        creatives: creatives.map(publicFile),
        campaigns,
        connections: connections.map(connectionSummary),
        employees,
        metrics,
        jobs: publicJobs,
        automationFlows: jobs.filter(j => j.type === 'platform_automation').map(describeAutomaticFlow),
        optimizationTasks,
        capabilities: {
          capabilityCatalog: remoteMode ? [] : capabilityCatalog,
          storage: !!env.BUCKET,
          modelConfigured: env.BXAGI_BUTLER_ENABLED === 'true' || env.BXAGI_PLANNER_ENABLED === 'true',
          plannerMode: env.BXAGI_BUTLER_ENABLED === 'true' ? 'official_butler' : env.BXAGI_PLANNER_ENABLED === 'true' ? 'bxagi_employee' : 'rules',
          productionEngine: bxagi.connected ? 'bxagi' : remoteMode ? 'bxagi_required' : 'local_rules',
          bxagiRequired,
          bxagiProtocolVerified: true,
          bxagiLiveVerified: false,
          bxagiTransferMaxBytes: 16 * 1024 * 1024,
          storageUploadMaxBytes: 64 * 1024 * 1024,
          metricsTruncated: metrics.length >= 10000,
          collectionsTruncated: projects.length >= 500 || assets.length >= 500 || creatives.length >= 500 || campaigns.length >= 500 || metrics.length >= 10000,
          workerConfigured: !!env.APP_WORKER_SECRET,
          automaticScheduling: remoteMode,
          channels: CHANNELS.map(id => ({
            id,
            configured: connections.some(c => c.channel === id),
            adapter: id === 'oceanengine' ? 'requires_account_permissions' : 'not_configured'
          })),
          backgroundScheduling: backgroundScheduler.status === 'running',
          backgroundSchedulingConfigured: backgroundScheduler.configured,
          backgroundScheduler
        }
      }, 200, cookie ? {
        'Set-Cookie': cookie
      } : {});
    }
    if (path === '/employees' && method === 'GET') {
      const workflow = await remoteWorkflow();
      return json({
        employees: workflow ? await workflow.catalog() : [...employeeProfiles, ...customProfiles],
        capabilityCatalog: workflow ? [] : capabilityCatalog,
        provider: workflow ? 'bxagi' : 'local'
      });
    }
    if (path === '/employees' && method === 'POST') {
      if (remoteMode) {
        fail(409, '请在BXAGI员工中心管理实际雇佣员工', 'bxagi_employee_management');
      }
      const b = await parseJson(request);
      const name = string(b.name, 120),
        scene = string(b.scene, 80),
        role = b.role;
      if (!name || !scene || !['production', 'buying'].includes(role)) {
        fail(400, '请填写员工名称、类型与素材场景', 'invalid_employee');
      }
      const known = new Set(capabilityCatalog.filter(c => c.available).map(c => c.id));
      const capabilities = listStrings(b.capabilities, 30);
      if (capabilities.some(c => !known.has(c))) {
        fail(400, '员工能力必须使用已支持的能力，不支持任意执行代码', 'invalid_capability');
      }
      const definition = {
        name,
        scene,
        role,
        keywords: listStrings(b.keywords, 30),
        instructions: string(b.instructions, 12000),
        capabilities,
        version: '1.0.0',
        channels: CHANNELS.includes(b.channel) ? [b.channel] : CHANNELS,
        objectives: OBJECTIVES.includes(b.objective) ? [b.objective] : OBJECTIVES,
        scenes: [scene],
        engine: 'rules'
      };
      const row = await repository.createEmployeeProfile(userId, {
        name,
        scene,
        role,
        definition
      });
      await repository.addAudit(userId, {
        action: 'employee.created',
        entityType: 'employee',
        entityId: row.id,
        details: {
          scene,
          role
        }
      });
      return json({
        employee: customDefinitions([row])[0]
      }, 201);
    }
    if (path === '/projects' && method === 'GET') {
      return json({
        projects: await repository.listProjects(userId)
      });
    }
    if (path === '/projects' && method === 'POST') {
      const b = await parseJson(request);
      const title = string(b.title, 180);
      if (!title) {
        fail(400, '请输入项目名称', 'invalid_project');
      }
      if (b.objective && !OBJECTIVES.includes(b.objective)) {
        fail(400, '不支持该投放目标', 'invalid_objective');
      }
      const landingUrl = string(b.landingUrl, 2000);
      if (landingUrl && !/^https?:\/\//i.test(landingUrl)) {
        fail(400, '落地页必须使用HTTP或HTTPS地址', 'invalid_landing_url');
      }
      const p = await repository.createProject(userId, {
        title,
        productName: string(b.productName, 180),
        description: string(b.description, 12000),
        facts: listStrings(b.facts),
        objective: b.objective || 'purchase',
        audience: string(b.audience, 2000),
        landingUrl,
        sourceState: {version:1,status:'empty'},
        scene: string(b.scene,80) || 'general'
      });
      const project = p;
      await repository.addAudit(userId, {
        action: 'project.created',
        entityType: 'project',
        entityId: project.id,
        details: {
          scene: project.scene
        }
      });
      return json({
        project
      }, 201);
    }
    let match;
    if (match = /^\/projects\/([^/]+)\/(assets|plan|creatives|export)$/.exec(path)) {
      let project = requireRow(await repository.getProject(userId, match[1]));
      const action = match[2];
      if (action === 'export' && method === 'GET') {
        const [assets, creatives, campaigns] = await Promise.all([repository.listAssets(userId, project.id), repository.listCreatives(userId, project.id), repository.listCampaigns(userId)]);
        return json({
          version: '2.2.0',
          exportedAt: new Date().toISOString(),
          project,
          assets: assets.map(publicFile),
          creatives: creatives.map(publicFile),
          campaigns: campaigns.filter(c => c.projectId === project.id),
          employeeAssignments: project.assignment,
          notice: '文件通过授权contentUrl下载；投放凭据不会导出。'
        });
      }
      if (method !== 'POST') {
        fail(405, '该操作需要POST请求', 'method_not_allowed');
      }
      if (action === 'assets') {
        const role = request.headers.get('X-Asset-Role') || 'source';
        if (!['source', 'reference', 'transcript', 'copy'].includes(role)) {
          fail(400, '不支持该素材用途', 'invalid_role');
        }
        let metadata = {};
        try { metadata = JSON.parse(decodeURIComponent(request.headers.get('X-Creative-Metadata') || '{}')); }
        catch { fail(400,'素材元数据格式错误','invalid_metadata'); }
        if(!metadata || typeof metadata !== 'object' || Array.isArray(metadata))fail(400,'素材元数据格式错误','invalid_metadata');
        const batchId = string(new URL(request.url).searchParams.get('batchId') || request.headers.get('X-Upload-Batch-Id') || metadata.batchId,100);
        const production = createProductionService({repository,bucket:env.BUCKET,context:authenticated,orchestrator:remoteWorkflow,ensureAutomation:id=>automatic().ensureProject(authenticated,id)});
        const uploadRequestId = string(request.headers.get('X-Upload-Request-Id') || metadata.uploadRequestId,100) || null;
        if(uploadRequestId && (!batchId || !/^[A-Za-z0-9_-]{8,100}$/.test(uploadRequestId)))fail(400,'上传请求标识无效','invalid_upload_request');
        const replay = async () => {
          if(!uploadRequestId || !repository.findAssetUpload)return null;
          const prior=await repository.findAssetUpload(userId,project.id,uploadRequestId);
          if(!prior)return null;
          if(prior.metadata?.uploadBatchId!==batchId || prior.mimeType!==(request.headers.get('Content-Type')||'').split(';')[0].toLowerCase())fail(409,'上传请求与已有文件不一致','upload_request_conflict');
          return json({asset:publicFile(prior),project,assignment:project.assignment,job:null,reused:true},200);
        };
        const existingUpload=await replay();if(existingUpload){await request.body?.cancel().catch(()=>{});return existingUpload;}
        if(batchId)await production.assertBatchUpload(project.id,batchId);
        const uploaded = await putUpload(request, env.BUCKET, userId, 'assets');
        let asset;
        try {
          if(batchId)await production.assertBatchUpload(project.id,batchId);
          asset = await repository.createAsset(userId, {
            ...uploaded, projectId:project.id, role, status:'uploaded', uploadRequestId,
            metadata:{...uploaded.metadata,...(batchId?{uploadBatchId:batchId}:{})}
          });
        } catch(error) { await env.BUCKET.delete(uploaded.objectKey); const persisted=await replay(); if(persisted)return persisted; throw error; }
        await repository.addAudit(userId,{action:'asset.uploaded',entityType:'asset',entityId:asset.id,details:{projectId:project.id,batchId:batchId||null,size:asset.size,mimeType:asset.mimeType}});
        return json({asset:publicFile(asset),project,assignment:project.assignment,job:null},201);
      }
      if (action === 'plan') {
        const input = await parseJson(request);
        const workflow = await remoteWorkflow();
        if (workflow) {
          return json(await workflow.submitProduction(project, {
            optimizationTaskId: string(input.optimizationTaskId, 100) || undefined
          }));
        }
        if (!input.optimizationTaskId && project.creativePlan?.optimization?.taskId) {
          const active = requireRow(await repository.getOptimizationTask(userId, project.creativePlan.optimization.taskId));
          if (active.status === 'producing' && Date.parse(active.metadata?.productionLeaseExpiresAt ?? '') > Date.now()) {
            fail(409, '该项目正在生成反馈优化素材，请等待本轮完成', 'optimization_in_progress');
          }
        }
        let optimizationTask, optimizationContext, productionLeaseId;
        if (input.optimizationTaskId) {
          optimizationTask = requireRow(await repository.getOptimizationTask(userId, string(input.optimizationTaskId, 100)));
          if (optimizationTask.projectId !== project.id) {
            fail(400, '优化任务不属于该素材项目', 'invalid_optimization_task');
          }
          const campaign = requireRow(await repository.getCampaign(userId, optimizationTask.campaignId));
          if (campaign.projectId !== project.id) {
            fail(400, '优化任务投放计划与项目不匹配', 'invalid_optimization_task');
          }
          const metricId = optimizationTask.metadata?.metricId || optimizationTask.metadata?.sourceMetricId;
          const metric = metricId ? requireRow(await repository.getMetric(userId, metricId)) : null;
          if (metric && (metric.campaignId !== campaign.id || metric.projectId !== project.id)) {
            fail(400, '优化任务与反馈数据不匹配', 'invalid_optimization_metric');
          }
          productionLeaseId = crypto.randomUUID();
          optimizationTask = await repository.claimOptimizationTask(userId, optimizationTask.id, productionLeaseId);
          if (!optimizationTask) {
            fail(409, '该优化任务已在处理或已完成，请刷新任务状态', 'optimization_in_progress');
          }
          optimizationContext = {
            taskId: optimizationTask.id,
            reason: optimizationTask.reason,
            iteration: Number(optimizationTask.metadata?.iteration ?? 0) + 1,
            campaignSnapshot: {
              id: campaign.id,
              creativeIds: campaign.creativeIds,
              targetRoi: campaign.targetRoi,
              objective: campaign.objective
            },
            metricSnapshot: metric ? {
              id: metric.id,
              source: metric.source,
              dataFresh: metric.dataFresh,
              impressions: metric.impressions,
              clicks: metric.clicks,
              spend: metric.spend,
              revenue: metric.revenue,
              conversions: metric.conversions,
              hasConversion: metric.hasConversion,
              scope: 'campaign',
              proof: metric.metadata?.proof
            } : null
          };
        }
        try {
          project = await classify(project);
          const assets = await repository.listAssets(userId, project.id);
          const plan = await buildCreativePlan({
            project,
            assets
          }, {
            customProfiles,
            ...(optimizationContext ? {
              optimizationContext
            } : {})
          });
          if (optimizationTask) {
            const ready = plan.optimization?.status === 'experiment_ready';
            optimizationTask = await repository.updateOptimizationTask(userId, optimizationTask.id, {
              status: plan.optimization?.needsExternalVideoProduction ? 'needs_external_video_production' : ready ? 'producing' : 'awaiting_data',
              metadata: {
                ...optimizationTask.metadata,
                iteration: optimizationContext.iteration,
                activeRevision: plan.revision,
                planVariantIds: plan.variants.map(v => v.id),
                optimization: plan.optimization,
                sourceMetricId: optimizationContext.metricSnapshot?.id ?? null
              }
            });
          }
          project = await repository.updateProject(userId, project.id, {
            creativePlan: plan,
            assignment: plan.assignment,
            scene: plan.assignment.scene,
            productionEmployeeId: plan.assignment.productionEmployeeId
          });
          await repository.addAudit(userId, {
            action: optimizationTask ? 'creative.iteration_planned' : 'creative.planned',
            entityType: 'project',
            entityId: project.id,
            details: {
              variantCount: plan.variants.length,
              engine: 'rules',
              optimizationTaskId: optimizationTask?.id ?? null,
              revision: plan.revision ?? 'initial',
              feedbackStatus: plan.optimization?.status ?? 'not_requested'
            }
          });
          return json({
            project,
            ...plan,
            ...(optimizationTask ? {
              optimizationTask
            } : {})
          });
        } catch (error) {
          if (optimizationTask && productionLeaseId) {
            await repository.releaseOptimizationTask(userId, optimizationTask.id, productionLeaseId);
          }
          throw error;
        }
      }
      if (action === 'creatives') {
        let b = {};
        try {
          b = JSON.parse(decodeURIComponent(request.headers.get('X-Creative-Metadata') || '{}'));
        } catch {
          fail(400, '素材元数据格式错误', 'invalid_metadata');
        }
        if (!b || typeof b !== 'object' || Array.isArray(b)) {
          fail(400, '素材元数据必须是对象', 'invalid_metadata');
        }
        const ids = listStrings(b.sourceAssetIds, 100);
        for (const id of ids) {
          const asset = requireRow(await repository.getAsset(userId, id));
          if (asset.projectId !== project.id) {
            fail(400, '原始素材不属于该项目', 'invalid_asset');
          }
        }
        const uploaded = await putUpload(request, env.BUCKET, userId, 'creatives');
        const dimensions = uploaded.metadata;
        for (const k of ['width', 'height']) {
          if (dimensions[k] && b[k] && dimensions[k] !== Number(b[k])) {
            await env.BUCKET.delete(uploaded.objectKey);
            fail(400, '图片实际尺寸与元数据不一致', 'invalid_dimensions');
          }
        }
        const associatedVariant = project.creativePlan?.variants?.find(v => v.id === string(b.variantId, 160));
        const planOptimization = associatedVariant && project.creativePlan?.optimization?.status === 'experiment_ready' ? project.creativePlan.optimization : null;
        const record = {
          ...uploaded,
          projectId: project.id,
          title: string(b.title, 180) || uploaded.filename,
          variantId: string(b.variantId, 160),
          format: ['portrait', 'square', 'landscape'].includes(b.format) ? b.format : 'square',
          employeeId: project.productionEmployeeId,
          sourceAssetIds: ids,
          validation: ['browser-metadata', 'operator-reviewed'].includes(b.validation) ? b.validation : 'unverified',
          width: dimensions.width || Number(b.width) || null,
          height: dimensions.height || Number(b.height) || null,
          duration: Number(b.duration) || null,
          status: 'draft',
          metadata: {
            ...dimensions,
            semanticValidated: false,
            ...(planOptimization ? {
              optimizationTaskId: planOptimization.taskId,
              planRevision: project.creativePlan.revision,
              sourceMetricId: planOptimization.metricId ?? null
            } : {})
          }
        };
        let creative;
        try {
          creative = await repository.createCreative(userId, record);
        } catch (error) {
          await env.BUCKET.delete(uploaded.objectKey);
          throw error;
        }
        await repository.addAudit(userId, {
          action: 'creative.saved',
          entityType: 'creative',
          entityId: creative.id,
          details: {
            projectId: project.id,
            validation: creative.validation
          }
        });
        return json({
          creative: publicFile(creative)
        }, 201);
      }
    }
    if ((match = /^\/(assets|creatives)\/([^/]+)\/content$/.exec(path)) && method === 'GET') {
      return contentResponse(request, requireRow(await (match[1] === 'assets' ? repository.getAsset(userId, match[2]) : repository.getCreative(userId, match[2]))), env.BUCKET);
    }
    if ((match = /^\/creatives\/([^/]+)\/review$/.exec(path)) && method === 'POST') {
      const creative = requireRow(await repository.getCreative(userId, match[1]));
      const b = await parseJson(request);
      if (typeof b.approved !== 'boolean') {
        fail(400, '请明确审核通过或不通过', 'invalid_review');
      }
      const updated = await repository.updateCreative(userId, creative.id, {
        status: b.approved ? 'approved' : 'rejected',
        reviewedBy: userId,
        reviewedAt: new Date().toISOString()
      });
      await repository.addAudit(userId, {
        action: 'creative.reviewed',
        entityType: 'creative',
        entityId: creative.id,
        details: {
          approved: b.approved
        }
      });
      return json({
        creative: publicFile(updated)
      });
    }
    if (path === '/connections' && method === 'GET') {
      return json({
        connections: (await repository.listConnections(userId)).map(connectionSummary)
      });
    }
    if (path === '/connections' && method === 'POST') {
      if (!env.APP_ENCRYPTION_KEY) {
        fail(503, '服务端凭据加密密钥未配置，暂不能保存广告账户', 'encryption_unavailable');
      }
      const b = await parseJson(request);
      if (!CONNECTION_PROVIDERS.includes(b.channel) || !string(b.accountId, 100) || !string(b.accessToken, 16000)) {
        fail(400, '请填写投放平台、广告账户与访问凭据', 'invalid_connection');
      }
      const expiry = string(b.expiresAt, 100);
      if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) {
        fail(400, '凭据有效期必须是有效的未来时间', 'invalid_expiry');
      }
      const secretsCiphertext = await encryptConnectionSecrets({
        accessToken: string(b.accessToken, 16000),
        appSecret: string(b.appSecret, 16000)
      }, env.APP_ENCRYPTION_KEY);
      const connection = await repository.createConnection(userId, {
        channel: b.channel,
        accountId: string(b.accountId, 100),
        label: string(b.label, 180) || '广告账户',
        secretsCiphertext,
        expiresAt: string(b.expiresAt, 100) || null,
        appId: string(b.appId, 100) || null,
        status: 'configured'
      });
      await repository.addAudit(userId, {
        action: 'connection.created',
        entityType: 'connection',
        entityId: connection.id,
        details: {
          channel: connection.channel
        }
      });
      return json({
        connection: connectionSummary(connection)
      }, 201);
    }
    if (path === '/campaigns' && method === 'GET') {
      return json({
        campaigns: await repository.listCampaigns(userId)
      });
    }
    if (path === '/campaigns' && method === 'POST') {
      const b = await parseJson(request);
      const project = requireRow(await repository.getProject(userId, string(b.projectId, 100)));
      const ids = [...new Set(listStrings(b.creativeIds, 20))];
      if (!ids.length) {
        fail(400, '请选择实际生成的广告素材', 'missing_creatives');
      }
      for (const id of ids) {
        const c = requireRow(await repository.getCreative(userId, id));
        if (c.projectId !== project.id) {
          fail(400, '广告素材不属于该项目', 'invalid_creative');
        }
        await assertCreativeDeliveryComplete({
          repository,
          userId,
          creative: c
        });
      }
      if (!CHANNELS.includes(b.channel)) {
        fail(400, '不支持该投放平台', 'invalid_channel');
      }
      const serverMax = Number(env.APP_MAX_DAILY_BUDGET) || 1000;
      const maxDailyBudget = positive(b.maxDailyBudget ?? b.dailyBudget, '每日预算上限', serverMax),
        dailyBudget = positive(b.dailyBudget, '日预算', maxDailyBudget),
        totalBudget = positive(b.totalBudget, '总预算');
      if (totalBudget < dailyBudget) {
        fail(400, '总预算不能低于日预算', 'invalid_budget');
      }
      const connectionId = string(b.connectionId, 100) || null;
      if (connectionId) {
        const connection = requireRow(await repository.getConnection(userId, connectionId));
        if (connection.channel !== b.channel) {
          fail(400, '广告账户平台与投放平台不匹配', 'invalid_connection');
        }
      }
      if (containsSecretKey(b.platformConfig)) {
        fail(400, '投放凭据必须通过广告账户连接保存，不能放入计划配置', 'unsafe_credentials');
      }
      const objective = OBJECTIVES.includes(b.objective) ? b.objective : project.objective;
      const employee = selectBuyingEmployee({
        scene: project.scene,
        objective,
        channel: b.channel
      }, customProfiles);
      const campaign = await repository.createCampaign(userId, {
        projectId: project.id,
        creativeIds: ids,
        name: string(b.name, 180) || `${project.title}投放计划`,
        channel: b.channel,
        dailyBudget,
        totalBudget,
        maxDailyBudget,
        targetRoi: positive(b.targetRoi ?? 1, '目标ROI', 1000),
        objective,
        autoOptimize: b.autoOptimize === true,
        connectionId,
        platformConfig: b.platformConfig && typeof b.platformConfig === 'object' && !Array.isArray(b.platformConfig) ? b.platformConfig : {},
        buyingEmployeeId: remoteMode ? '' : employee.id,
        status: 'draft'
      });
      await repository.addAudit(userId, {
        action: 'campaign.created',
        entityType: 'campaign',
        entityId: campaign.id,
        details: {
          dailyBudget,
          totalBudget,
          buyingEmployeeId: employee.id
        }
      });
      return json({
        campaign
      }, 201);
    }
    if ((match = /^\/campaigns\/([^/]+)\/budget$/.exec(path)) && method === 'POST') {
      const campaign = requireRow(await repository.getCampaign(userId, match[1]));
      const b = await parseJson(request),
        serverMax = Number(env.APP_MAX_DAILY_BUDGET) || 1000;
      const maxDailyBudget = positive(b.maxDailyBudget ?? campaign.maxDailyBudget, '每日预算上限', serverMax),
        dailyBudget = positive(b.dailyBudget ?? campaign.dailyBudget, '日预算', maxDailyBudget),
        totalBudget = positive(b.totalBudget ?? campaign.totalBudget, '总预算'),
        targetRoi = positive(b.targetRoi ?? campaign.targetRoi, '目标ROI', 1000);
      if (totalBudget < dailyBudget) {
        fail(400, '总预算不能低于日预算', 'invalid_budget');
      }
      if (['active','paused'].includes(campaign.status) && campaign.remoteState?.projectId) {
        return json(await ads.adjustBudget(userId,campaign,{dailyBudget,totalBudget,maxDailyBudget,targetRoi}));
      }
      return await withDeliveryGroupLock(repository,userId,campaign.deliveryGroupId,async()=>{
      const operationId = crypto.randomUUID(),
        locked = await repository.claimCampaignBudgetOperation(userId, campaign.id, operationId);
      if (!locked) {
        fail(409, '请先暂停投放，并等待正在进行或结果待核对的渠道操作结束', 'budget_edit_blocked');
      }
      try {
        await assertDeliveryGroupAllocation(repository,userId,locked,{dailyBudget,totalBudget,maxDailyBudget,targetRoi});
        const updated = await repository.updateCampaign(userId, campaign.id, {
          dailyBudget,
          totalBudget,
          maxDailyBudget,
          targetRoi
        });
        await repository.addAudit(userId, {
          action: 'campaign.budget_edited',
          entityType: 'campaign',
          entityId: campaign.id,
          details: {
            before: {
              dailyBudget: locked.dailyBudget,
              totalBudget: locked.totalBudget,
              maxDailyBudget: locked.maxDailyBudget,
              targetRoi: locked.targetRoi
            },
            after: {
              dailyBudget,
              totalBudget,
              maxDailyBudget,
              targetRoi
            },
            remoteStatus: 'inactive_until_explicit_launch'
          }
        });
        return json({
          campaign: {
            ...updated,
            operationId: null
          }
        });
      } finally {
        await repository.releaseCampaignOperation(userId, campaign.id, operationId);
      }
      });
    }
    if ((match = /^\/campaigns\/([^/]+)\/(launch|pause|sync|metrics)$/.exec(path)) && method === 'POST') {
      const campaign = requireRow(await repository.getCampaign(userId, match[1]));
      const action = match[2];
      if (action !== 'metrics') return json(await executeCampaignAction({userId,repository,ads,remoteWorkflow},campaign,action));
      const b = await parseJson(request);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date + 'T00:00:00Z')) || new Date(b.date + 'T00:00:00Z').toISOString().slice(0, 10) !== b.date) {
        fail(400, '效果日期格式为YYYY-MM-DD', 'invalid_date');
      }
      const nonnegative = (v, name, optional = false) => {
        if (optional && (v === null || v === undefined || v === '')) {
          return null;
        }
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          fail(400, `${name}必须是非负数`, 'invalid_metric');
        }
        return v;
      };
      const spend = nonnegative(b.spend, '消耗'),
        hasConversion = b.hasConversion === true,
        revenue = hasConversion ? nonnegative(b.revenue, '收入', true) : null,
        conversions = hasConversion ? nonnegative(b.conversions, '转化次数', true) : null;
      const previous = (await repository.listMetrics(userId)).find(m => m.campaignId === campaign.id && m.date === b.date && m.source === 'manual');
      const metric = await repository.upsertMetrics(userId, {
        campaignId: campaign.id,
        date: b.date,
        source: 'manual',
        spend,
        revenue,
        conversions,
        hasConversion,
        dataFresh: b.dataFresh === true,
        roi: hasConversion && revenue !== null && spend > 0 ? revenue / spend : null,
        impressions: nonnegative(b.impressions, '展示次数', true),
        clicks: nonnegative(b.clicks, '点击次数', true),
        metadata: {
          reportSource: string(b.source, 180) || '用户导入平台报表',
          verifiedBy: userId
        }
      });
      const all = (await repository.listMetrics(userId)).filter(m => m.campaignId === campaign.id);
      const perDay = new Map();
      for (const m of all) {
        perDay.set(m.date, Math.max(perDay.get(m.date) || 0, m.spend));
      }
      const lifetimeSpend = [...perDay.values()].reduce((a, b) => a + b, 0);
      const decision = metricDecision(campaign, metric, lifetimeSpend);
      let optimizationTask;
      if (decision.action === 'iterate' && (!previous || ['spend', 'revenue', 'conversions', 'hasConversion', 'dataFresh', 'impressions', 'clicks'].some(k => previous[k] !== metric[k]))) {
        optimizationTask = await repository.addOptimizationTask(userId, {
          campaignId: campaign.id,
          projectId: campaign.projectId,
          type: 'creative_iteration',
          status: 'pending',
          reason: decision.reason,
          metadata: {
            metricId: metric.id,
            productionEmployeeId: (await repository.getProject(userId, campaign.projectId)).productionEmployeeId,
            roi: metric.roi,
            targetRoi: campaign.targetRoi
          }
        });
      }
      await repository.addAudit(userId, {
        action: 'metrics.imported',
        entityType: 'campaign',
        entityId: campaign.id,
        details: {
          metricId: metric.id,
          date: metric.date,
          source: 'manual',
          decision
        }
      });
      return json({
        metric,
        decision,
        optimizationTask
      });
    }
    if ((match = /^\/optimization-tasks\/([^/]+)\/retry$/.exec(path)) && method === 'POST') {
      const task = requireRow(await repository.getOptimizationTask(userId, match[1]));
      const b = await parseJson(request);
      if (!['producing', 'awaiting_data'].includes(task.status) || string(b.planRevision, 200) !== task.metadata?.activeRevision) {
        fail(409, '任务生产版本已变化，请刷新后重试', 'optimization_state_changed');
      }
      if (task.status === 'producing') {
        await repository.releaseOptimizationTask(userId, task.id, task.metadata.productionLeaseId);
      } else {
        await repository.updateOptimizationTask(userId, task.id, {
          status: 'pending'
        });
      }
      const optimizationTask = await repository.getOptimizationTask(userId, task.id);
      await repository.addAudit(userId, {
        action: 'optimization.retry_requested',
        entityType: 'optimizationTask',
        entityId: task.id,
        details: {
          revision: task.metadata.activeRevision,
          reason: string(b.reason, 500) || '重试素材生产'
        }
      });
      return json({
        optimizationTask
      });
    }
    if ((match = /^\/optimization-tasks\/([^/]+)\/complete$/.exec(path)) && method === 'POST') {
      const task = requireRow(await repository.getOptimizationTask(userId, match[1]));
      if (task.status === 'completed') {
        return json({
          optimizationTask: task,
          replayed: true
        });
      }
      if (task.status !== 'producing' || task.metadata?.optimization?.status !== 'experiment_ready') {
        fail(409, '优化任务尚未生成有充分反馈依据的生产方案', 'optimization_not_producing');
      }
      if (!Number.isFinite(Date.parse(task.metadata.productionLeaseExpiresAt ?? '')) || Date.parse(task.metadata.productionLeaseExpiresAt ?? '') <= Date.now()) {
        fail(409, '优化任务处理租约已过期，请重新生成方案', 'optimization_lease_expired');
      }
      const b = await parseJson(request),
        ids = [...new Set(listStrings(b.creativeIds, 20))];
      if (!ids.length) {
        fail(400, '请提供实际新增的优化成品', 'missing_optimization_creatives');
      }
      for (const id of ids) {
        const creative = requireRow(await repository.getCreative(userId, id));
        if (creative.projectId !== task.projectId || creative.createdAt < task.createdAt || creative.metadata?.optimizationTaskId !== task.id || creative.metadata?.planRevision !== task.metadata.activeRevision || !task.metadata.planVariantIds?.includes(creative.variantId) || creative.status === 'rejected') {
          fail(400, '成品必须来自该优化任务的新版本生产方案', 'invalid_optimization_creative');
        }
        const object = await env.BUCKET.get(creative.objectKey);
        if (!object || !creative.size) {
          fail(400, '优化成品的实际文件不存在', 'optimization_content_missing');
        }
      }
      const optimizationTask = await repository.completeOptimizationTask(userId, task.id, task.metadata.productionLeaseId, {
        ...task.metadata,
        resultCreativeIds: ids,
        completedAt: new Date().toISOString(),
        completionType: 'new_creatives_generated',
        efficacyVerified: false
      });
      if (!optimizationTask) {
        fail(409, '优化任务状态已变化，请刷新', 'optimization_state_changed');
      }
      await repository.addAudit(userId, {
        action: 'optimization.creatives_completed',
        entityType: 'optimizationTask',
        entityId: task.id,
        details: {
          revision: task.metadata.activeRevision,
          creativeIds: ids,
          efficacyVerified: false
        }
      });
      return json({
        optimizationTask
      });
    }
    if ((match = /^\/bxagi\/jobs\/([^/]+)\/(sync|collect)$/.exec(path)) && method === 'POST') {
      const job = requireRow(await repository.getJob(userId, match[1])),
        context = await bxagiContext(true),
        worker = workforceFor(context);
      return json(await (match[2] === 'collect' || isCollectableBxagiProductionJob(job) ? worker.collectProduction(match[1]) : worker.syncJob(match[1])));
    }
    if (path === '/audit' && method === 'GET') {
      return json({
        audit: await repository.listAudit(userId)
      });
    }
    fail(404, '接口不存在', 'not_found');
  } catch (error) {
    if (error.status === 401 && activeBxagiContext) {
      await invalidateBxagiContext(activeBxagiContext, env);
      error.clearCookie = true;
    }
    const status = Number(error.status) || 500;
    return json({
      error: {
        message: status >= 500 && !error.status ? '服务暂时不可用，请重试' : error.message,
        code: error.code || 'request_failed',
        ...(error.reasons ? {
          reasons: error.reasons
        } : {})
      }
    }, status, error.clearCookie ? {
      'Set-Cookie': clearBxagiCookie()
    } : {});
  }
}
