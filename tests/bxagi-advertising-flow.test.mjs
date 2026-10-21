import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';

// One offline module-handoff trace. Employees and channel responses are fixtures,
// not evidence of live production, advertising, account permissions or efficacy.
function database() {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...args) { return {
      async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    }; } };
  } };
}
function bucket() {
  const objects = new Map();
  return {
    async put(key, body) { const bytes = new Uint8Array(await new Response(body).arrayBuffer()); objects.set(key, bytes); return { size: bytes.length }; },
    async get(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes]).stream(), async arrayBuffer() { return bytes.slice().buffer; } } : null; },
    async delete(key) { objects.delete(key); },
  };
}
function png(red, green, blue) {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, body) => { const content = Buffer.concat([Buffer.from(name), body]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(body.length); checksum.writeUInt32BE(crc(content)); return Buffer.concat([length, content, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(24); header.writeUInt32BE(24, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(24 * 97);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) pixels.set([red, green, blue, 255], y * 97 + 1 + x * 4);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}
const config = {
  budgetUnit: 'yuan',
  project: { ad_type: 'ALL', landing_type: 'LINK', marketing_goal: 'VIDEO_AND_IMAGE', delivery_range: { inventory_catalog: 'MANUAL' }, delivery_setting: { bid_type: 'NO_BID', budget_mode: 'BUDGET_MODE_DAY', pricing: 'PRICING_CPC' } },
  promotion: {},
  report: { dimensions: ['project_id'], metrics: ['stat_cost', 'show_cnt', 'click_cnt'], filters: [], order_by: [], data_topic: 'BASIC_DATA' },
  metricMapping: { projectId: 'project_id', spend: 'stat_cost', impressions: 'show_cnt', clicks: 'click_cnt' },
  landingUrl: 'https://shop.example.com/fixture', titles: ['用户提供的产品事实'],
};

test('offline PNG production → review → budget draft → explicit launch/readback → channel metrics → second PNG', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('This fixture must never make a live network request'); });
  const env = { DB: database(), BUCKET: bucket(), BXAGI_REQUIRED: 'true', APP_ENCRYPTION_KEY: '71'.repeat(32) };
  t.after(() => env.DB.sqlite.close());
  const repo = createPlatformRepository(env.DB), owner = 'cross-stage-owner';
  const context = { userId: owner, nativeUserId: owner, subject: 'cross-stage-subject', accessToken: 'offline-bxagi-token', profile: { id: 'cross-stage-subject' } };
  const sourcePng = png(100, 100, 100), firstPng = png(220, 60, 90), secondPng = png(40, 160, 90);
  const trace = [], files = new Map(), messages = new Set(), employees = [
    ['production', '视频优化专家'], ['buying', '广告投放员工'],
  ].map(([id, name]) => ({ id: `bxagi:market:${id}`, providerId: id, marketId: id, name, provider: 'bxagi', resourceType: 'installed_employee', marketVerified: true, activationState: 'ready', sourceVerified: true, usable: true, conversationId: `installed-${id}` }));
  const workforce = {
    async listEmployees() { return employees; },
    async createConversation({ jobId, employee }) { trace.push(`employee.create:${employee.providerId}`); return { startTaskId: jobId }; },
    async getStartTask(id) { return { status: 'READY', conversationId: id }; },
    async getConversation(id) { const source=employees.find(employee=>employee.conversationId===id);if(source)return {id,employeeId:source.providerId,created_by_user_id:context.subject,executionStatus:'RUNNING'};const job = await repo.getJob(owner, id); assert.ok(job); return { id, employeeId: job.details.employee.providerId, created_by_user_id:context.subject, executionStatus: 'RUNNING' }; },
    async ensureRuntime() { return { status: 'ready' }; },
    async uploadFile({ directory, filename, blob }) { const path = `${directory}/${filename}`; files.set(path, new Uint8Array(await blob.arrayBuffer())); return { relativePath: path }; },
    async sendMessage(id, prompt) {
      assert.equal(messages.has(id), false, 'each employee instruction is sent once'); messages.add(id);
      const job = await repo.getJob(owner, id), brief = JSON.parse(new TextDecoder().decode(files.get(`bxagi-advertising/${id}/input/brief.json`)));
      assert.equal(brief.jobId, job.id); assert.equal(brief.kind, job.details.kind); assert.match(prompt, /不要自行购买、雇佣、续费/);
      assert.deepEqual(files.get(brief.sourceFiles[0].path), job.details.kind === 'buying' ? firstPng : sourcePng);
      trace.push(`employee.instruction:${job.details.kind}`);
      return { transport: 'bxagi_ws', messageAcknowledged: true, eventId: `fixture-event-${id}`, liveVerified: false };
    },
    async readManifest({ conversation }) {
      const job = await repo.getJob(owner, conversation.id); assert.ok(job.details.messageAcknowledged);
      if (job.details.kind === 'buying') return { version: 1, jobId: job.id, kind: 'buying', decision: { action: job.details.action, campaignId: job.details.campaignId, inputVersion: job.details.inputVersion } };
      return { version: 1, jobId: job.id, kind: 'production', creatives: [{ path: `bxagi-advertising/${job.id}/output/result.png`, filename: 'result.png', mimeType: 'image/png', role:'primary', title: '离线图像夹具', format: 'square', sourceAssetIds: job.details.assetIds, factsUsed: ['用户提供的产品事实'] }] };
    },
    async readArtifact({ conversation }) { const job = await repo.getJob(owner, conversation.id); trace.push(job.details.optimizationTaskId ? 'artifact.second' : 'artifact.first'); return new Response(job.details.optimizationTaskId ? secondPng : firstPng); },
  };
  const channelCalls = []; let channelStatus = 'DISABLE';
  const fetcher = async (input, options) => {
    const url = new URL(input); assert.equal(url.origin, 'https://api.oceanengine.com'); assert.equal(options.headers['Access-Token'], 'offline-channel-token');
    const path = url.pathname; channelCalls.push({ path, method: options.method }); trace.push(`channel:${path}`);
    let data;
    if (path === '/open_api/v3.0/report/custom/config/get/') data = { list: [{ data_topic: 'BASIC_DATA', dimensions: [{ field: 'project_id', filter_able: true, filter_config: { type: 2, operator: 7 } }], metrics: config.report.metrics.map(field => ({ field })) }] };
    else if (path === '/open_api/2/file/image/ad/') { assert.deepEqual(new Uint8Array(await options.body.get('image_file').arrayBuffer()), firstPng); data = { id: 'fixture-image-id' }; }
    else if (path === '/open_api/v3.0/project/create/') { const body = JSON.parse(options.body); assert.equal(body.operation, 'DISABLE'); assert.equal(body.delivery_setting.budget, 100); data = { project_id: 901 }; }
    else if (path === '/open_api/v3.0/promotion/create/') { const body = JSON.parse(options.body); assert.equal(body.operation, 'DISABLE'); assert.equal(body.project_id, 901); assert.equal(body.promotion_materials.image_material_list[0].images[0].image_id, 'fixture-image-id'); data = { promotion_id: 902 }; }
    else if (['/open_api/v3.0/project/status/update/', '/open_api/v3.0/promotion/status/update/'].includes(path)) { channelStatus = JSON.parse(options.body).data[0].opt_status; data = { errors: [] }; }
    else if (path === '/open_api/v3.0/project/list/') data = { list: [{ project_id: 901, advertiser_id: 12345, opt_status: channelStatus, delivery_setting: { budget_mode: 'BUDGET_MODE_DAY', budget: 100 } }] };
    else if (path === '/open_api/v3.0/promotion/list/') data = { list: [{ promotion_id: 902, project_id: 901, advertiser_id: 12345, opt_status: channelStatus }] };
    else if (path === '/open_api/v3.0/report/custom/get/') { assert.ok(JSON.parse(url.searchParams.get('filters')).some(row => row.field === 'project_id' && row.values[0] === '901')); data = { rows: [{ dimensions: { project_id: '901' }, metrics: { stat_cost: '20', show_cnt: '2000', click_cnt: '50' } }], page_info: { total_page: 1 } }; }
    else assert.fail(`Unexpected channel fixture request: ${path}`);
    return Response.json({ code: 0, data, request_id: `fixture-request-${channelCalls.length}` });
  };
  async function call(path, { body = {}, raw, method = 'POST', headers = {} } = {}) {
    const response = await handlePlatformRequest(new Request(`https://fixture.example/api/v2${path}`, { method, headers: { ...(raw ? { 'Content-Type': 'image/png', 'X-Filename': 'source.png' } : { 'Content-Type': 'application/json' }), ...headers }, ...(method === 'GET' ? {} : { body: raw || JSON.stringify(body) }) }), env, { repository: repo, fetcher, bxagiWorkforce: workforce, resolveBxagiContext: async () => context });
    const data = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`); return data;
  }
  async function tick() {
    for (const flow of (await repo.listJobs(owner)).filter(row => row.type === 'platform_automation')) await repo.updateJob(owner, flow.id, { details: { ...flow.details, nextActionAt: '2000-01-01T00:00:00Z' } });
    return call('/automation/tick');
  }
  async function until(predicate) { for (let count = 0; count < 24; count++) { if (await predicate()) return; const result = await tick(); assert.ok(!result.results.some(row => row.waiting?.requiresUser && !['awaiting_budget', 'awaiting_explicit_launch'].includes(row.waiting.code)), JSON.stringify(result)); } assert.fail('Cross-stage fixture did not reach its bounded checkpoint'); }

  const { project } = await call('/projects', { body: { title: '产品素材流程夹具', productName: '产品', objective: 'views', facts: ['用户提供的产品事实'] } });
  const { batch } = await call(`/projects/${project.id}/upload-batches`, {body:{expectedCount:1}});
  const { asset } = await call(`/projects/${project.id}/assets?batchId=${batch.id}`, { raw: sourcePng });
  assert.equal((await repo.listJobs(owner)).filter(row=>row.type==='bxagi_workflow').length,0,'upload must not dispatch');
  await call(`/projects/${project.id}/upload-batches/${batch.id}/complete`,{body:{assetIds:[asset.id]}});
  await call(`/projects/${project.id}/production`,{body:{batchId:batch.id,productionSpec:{targetCount:1,mediaType:'image',format:'square',employeeMode:'auto'}}});
  await until(async () => (await repo.listCreatives(owner, project.id)).length === 1);
  const first = (await repo.listCreatives(owner, project.id))[0];
  assert.equal(first.mimeType, 'image/png'); assert.deepEqual(first.sourceAssetIds, [asset.id]);
  assert.deepEqual(first.metadata.technicalChecks, { pngChunks: true, pngCrc: true, pngInflate: true }); assert.equal(first.width, 24); assert.equal(first.height, 24);
  assert.deepEqual(await call(`/creatives/${first.id}/content`, { method: 'GET' }), firstPng);
  assert.equal((await call(`/creatives/${first.id}/review`, { body: { approved: true } })).creative.status, 'approved');
  const { connection } = await call('/connections', { body: { channel: 'oceanengine', accountId: '12345', accessToken: 'offline-channel-token', expiresAt: new Date(Date.now() + 3600000).toISOString() } });
  const { campaign } = await call('/campaigns', { body: { projectId: project.id, creativeIds: [first.id], name: '离线预算草稿', channel: 'oceanengine', connectionId: connection.id, dailyBudget: 100, totalBudget: 500, maxDailyBudget: 100, objective: 'views', targetRoi: 1.5, autoOptimize: true, platformConfig: config } });
  assert.equal(campaign.status, 'draft'); assert.equal((await tick()).results[0].waiting.code, 'awaiting_explicit_launch');
  assert.equal(channelCalls.length, 0); assert.equal((await repo.listJobs(owner)).filter(row => row.details?.kind === 'buying').length, 0);

  const launch = await call(`/campaigns/${campaign.id}/launch`);
  assert.equal(launch.job.details.createdBy, owner); assert.ok(launch.job.details.authorizedAt); assert.match(launch.job.details.inputVersion, /^[0-9a-f]{64}$/); assert.equal(channelCalls.length, 0);
  await until(async () => (await repo.getJob(owner, launch.job.id)).status === 'completed');
  const active = await repo.getCampaign(owner, campaign.id); assert.equal(active.status, 'active'); assert.equal(active.remoteId, '901'); assert.deepEqual(active.remoteState.promotionIds, [902]);
  assert.ok(channelCalls.some(row => row.path.endsWith('/project/list/'))); assert.ok(channelCalls.some(row => row.path.endsWith('/promotion/list/')));
  const launchWrites = channelCalls.filter(row => row.method === 'POST').length; assert.equal(launchWrites, 5);

  await repo.updateCampaign(owner, campaign.id, { nextSyncAt: '2000-01-01T00:00:00Z' });
  await tick();
  const metrics = await repo.listMetrics(owner); assert.equal(metrics.length, 1); const metric = metrics[0];
  assert.equal(metric.source, 'oceanengine'); assert.equal(metric.projectId, project.id); assert.equal(metric.campaignId, campaign.id); assert.equal(metric.spend, 20); assert.equal(metric.impressions, 2000); assert.equal(metric.clicks, 50); assert.equal(metric.revenue, null); assert.equal(metric.roi, null); assert.ok(metric.metadata.proof.requestIds[0].startsWith('fixture-request-'));
  const tasks = await repo.listOptimizationTasks(owner); assert.equal(tasks.length, 1); const task = tasks[0]; assert.equal(task.metadata.sourceMetricId, metric.id); assert.equal(task.metadata.signal, 'ctr');
  await until(async () => (await repo.getOptimizationTask(owner, task.id)).status === 'completed');
  const creatives = await repo.listCreatives(owner, project.id); assert.equal(creatives.length, 2);
  const second = creatives.find(row => row.id !== first.id); assert.equal(second.metadata.optimizationTaskId, task.id); assert.equal(second.metadata.sourceMetricId, metric.id); assert.deepEqual(second.metadata.technicalChecks, first.metadata.technicalChecks);
  assert.deepEqual(await call(`/creatives/${second.id}/content`, { method: 'GET' }), secondPng); assert.notDeepEqual(firstPng, secondPng); assert.notEqual(second.objectKey, first.objectKey);
  const optimized = await repo.getJob(owner, second.metadata.sourceJobId); assert.equal(optimized.details.optimization.metricId, metric.id); assert.equal(optimized.details.optimization.signal.type, 'ctr'); assert.equal(optimized.details.efficacyVerified, false); assert.equal((await repo.getOptimizationTask(owner, task.id)).metadata.efficacyVerified, false);
  assert.deepEqual((await repo.getCampaign(owner, campaign.id)).creativeIds, [first.id]); assert.equal((await repo.getCampaign(owner, campaign.id)).dailyBudget, 100); assert.equal(channelCalls.filter(row => row.method === 'POST').length, launchWrites);
  assert.equal(trace.filter(value => value === 'employee.create:production').length, 2); assert.equal(trace.filter(value => value === 'employee.create:buying').length, 1); assert.equal(messages.size, 3);
  assert.ok(trace.indexOf('artifact.first') < trace.indexOf('employee.instruction:buying')); assert.ok(trace.indexOf('channel:/open_api/v3.0/report/custom/get/') < trace.indexOf('artifact.second'));
});
