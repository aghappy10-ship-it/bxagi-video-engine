/** Owner-scoped upload batches and explicit, immutable production requests. */
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const owner = context => context?.userId || context?.nativeUserId;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const MAX_FILE = 16 * 1024 * 1024;

export function normalizeProductionSpec(raw = {}) {
  if (!object(raw)) fail(400, 'invalid_production_spec', '请填写有效的素材生产设置');
  const targetCount = raw.targetCount ?? 1, mediaType = raw.mediaType ?? 'video', format = raw.format ?? 'portrait', employeeMode = raw.employeeMode ?? 'auto';
  if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 3 || !['image', 'video'].includes(mediaType) || !['portrait', 'square', 'landscape'].includes(format) || !['auto', 'manual'].includes(employeeMode)) fail(400, 'invalid_production_spec', '每批生成1至3条图片或视频，并选择有效画幅与员工模式');
  const employeeId = employeeMode === 'manual' ? raw.employeeId : null;
  if (employeeMode === 'manual' && (!id(employeeId) || !employeeId.startsWith('bxagi:market:'))) fail(400, 'invalid_production_employee', '请选择官方员工市场中的制作员工');
  if (raw.instructions !== undefined && (typeof raw.instructions !== 'string' || raw.instructions.length > 2000)) fail(400, 'invalid_production_spec', '优化要求最多2000字');
  return { version: 1, targetCount, mediaType, format, employeeMode, employeeId, instructions: (raw.instructions || '').trim() };
}
const sortedIds = values => [...values].sort();
const equalIds = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify(sortedIds(a)) === JSON.stringify(sortedIds(b));
export async function productionInputVersion(project, assets) {
  const input = { title: project.title, productName: project.productName, description: project.description, facts: project.facts || [], objective: project.objective, audience: project.audience, landingUrl: project.landingUrl };
  const bytes = new TextEncoder().encode(JSON.stringify({ input, assets: assets.map(a => ({ id: a.id, size: a.size, mimeType: a.mimeType, role: a.role || 'source' })).sort((a, b) => a.id.localeCompare(b.id)) }));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function checkAssets(assets, projectId, maxFile = MAX_FILE) {
  if (!assets.length || assets.length > 20 || assets.some(a => !a || a.projectId !== projectId || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > maxFile)) fail(422, 'production_sources_invalid', `素材必须是本项目1至20份实际文件，每份不超过${maxFile / 1024 / 1024}MiB${maxFile === MAX_FILE ? '；员工当前接收上限为16MiB，请先压缩或拆分' : ''}`);
}
export async function resolveProductionInputs({ repository: repo, userId, project, batchId, assetIds, productionSpec } = {}) {
  const sourceState = project.sourceState || {};
  if (!batchId && sourceState.version === 1) batchId = sourceState.batchId;
  if (!batchId) {
    if (sourceState.version === 1) fail(409, 'production_batch_required', '请先完成上传批次，再开始优化');
    const assets = await repo.listAssets(userId, project.id);
    return { assets, productionSpec: productionSpec ? normalizeProductionSpec(productionSpec) : null, batchId: null, inputVersion: null };
  }
  const batch = await repo.getJob(userId, batchId);
  if (!batch || batch.type !== 'upload_batch' || batch.projectId !== project.id || batch.userId !== userId) fail(404, 'upload_batch_not_found', '上传批次不存在');
  if (batch.status !== 'sealed' || !Array.isArray(batch.details?.assetIds)) fail(409, 'upload_batch_not_sealed', '本批文件尚未全部上传完成');
  if (assetIds && !equalIds(assetIds, batch.details.assetIds)) fail(409, 'production_input_changed', '生产输入与已封存的上传批次不一致');
  const assets = await Promise.all(batch.details.assetIds.map(assetId => repo.getAsset(userId, assetId)));
  checkAssets(assets, project.id);
  if (assets.some(a => a.metadata?.uploadBatchId !== batch.id && batch.details.reusedAssets !== true)) fail(409, 'production_input_changed', '素材与上传批次不一致');
  // The sealed input facts and file list are the source of truth even after a later upload.
  const frozenProject = { ...project, ...(batch.details.input || {}) };
  const inputVersion = await productionInputVersion(frozenProject, assets);
  if (inputVersion !== batch.details.inputVersion) fail(409, 'production_input_changed', '上传批次的原始文件发生变化');
  return { assets, batchId: batch.id, inputVersion, frozenProject, productionSpec: normalizeProductionSpec(productionSpec || batch.details.productionSpec || project.productionSpec || {}) };
}
const publicBatch = row => ({ id: row.id, projectId: row.projectId, status: row.status, expectedCount: row.details.expectedCount, assetIds: row.details.assetIds || [], inputVersion: row.details.inputVersion || null, startedJobId: row.details.startedJobId || null, sealedAt: row.details.sealedAt || null });

export function createProductionService({ repository: repo, bucket, context, orchestrator, ensureAutomation } = {}) {
  const userId = owner(context);
  if (!userId || !context?.subject) fail(401, 'bxagi_login_required', '请先登录BXAGI');
  const getProject = async projectId => { const project = await repo.getProject(userId, projectId); if (!project) fail(404, 'not_found', '素材项目不存在'); return project; };
  async function getBatch(projectId, batchId) {
    const batch = await repo.getJob(userId, batchId);
    if (!batch || batch.type !== 'upload_batch' || batch.projectId !== projectId || batch.details?.bxagiSubject !== context.subject) fail(404, 'upload_batch_not_found', '上传批次不存在');
    return batch;
  }
  async function locked(projectId, batchId, operation) {
    await getBatch(projectId, batchId);
    const operationId = crypto.randomUUID();
    const batch = await repo.claimJobOperation(userId, batchId, operationId);
    if (!batch) fail(409, 'upload_batch_busy', '本批次正在处理，请稍后刷新');
    try { return await operation(batch); } finally { await repo.releaseJobOperation(userId, batchId, operationId); }
  }
  async function beginBatch(projectId, { expectedCount, reuseAssetIds } = {}) {
    const project = await getProject(projectId);
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 20) fail(400, 'invalid_upload_count', '每个上传批次需包含1至20份文件');
    let reused = [];
    if (reuseAssetIds !== undefined) {
      if (!Array.isArray(reuseAssetIds) || reuseAssetIds.length > expectedCount || new Set(reuseAssetIds).size !== reuseAssetIds.length || reuseAssetIds.some(value => !id(value))) fail(400, 'invalid_upload_assets', '复用的素材数量与批次不一致');
      reused = await Promise.all(reuseAssetIds.map(assetId => repo.getAsset(userId, assetId)));
      if (reused.length) checkAssets(reused, project.id, 64 * 1024 * 1024);
    }
    const batch = await repo.createJob(userId, { projectId, employeeId: '', type: 'upload_batch', status: 'uploading', details: { version: 1, expectedCount, bxagiSubject: context.subject, assetIds: reused.map(a => a.id), reuseAssetIds: reused.map(a => a.id), reusedAssets: reused.length > 0 } });
    const updated = await repo.updateProject(userId, projectId, { sourceState: { version: 1, status: 'uploading', batchId: batch.id, assetIds: [], startedJobId: null } });
    return { batch: publicBatch(batch), project: updated };
  }
  async function assertBatchUpload(projectId, batchId) {
    await getProject(projectId);
    const batch = await getBatch(projectId, batchId);
    if (batch.status !== 'uploading') fail(409, 'upload_batch_closed', '本批次已封存，请新建上传批次');
    const uploaded = (await repo.listAssets(userId, projectId)).filter(a => a.metadata?.uploadBatchId === batch.id);
    if (uploaded.length + (batch.details.reuseAssetIds || []).length >= batch.details.expectedCount) fail(409, 'upload_batch_full', '本批次文件已齐，请完成上传');
    return publicBatch(batch);
  }
  async function completeBatch(projectId, batchId, { assetIds } = {}) {
    const project = await getProject(projectId);
    return locked(projectId, batchId, async batch => {
      if (!Array.isArray(assetIds) || assetIds.length !== batch.details.expectedCount || new Set(assetIds).size !== assetIds.length || assetIds.some(value => !id(value))) fail(422, 'upload_batch_incomplete', '请等待本批全部文件上传成功后再完成');
      if (batch.status === 'sealed') {
        if (!equalIds(assetIds, batch.details.assetIds)) fail(409, 'upload_batch_closed', '已封存批次不能修改');
        return { batch: publicBatch(batch), project: await getProject(projectId) };
      }
      const assets = await Promise.all(assetIds.map(assetId => repo.getAsset(userId, assetId)));
      checkAssets(assets, projectId, 64 * 1024 * 1024);
      if ((batch.details.reuseAssetIds || []).some(assetId => !assetIds.includes(assetId)) || assets.some(a => a.metadata?.uploadBatchId !== batch.id && !(batch.details.reuseAssetIds || []).includes(a.id))) fail(422, 'upload_batch_asset_mismatch', '素材不属于本次上传批次');
      for (const asset of assets) { const stored = await bucket.get(asset.objectKey); if (!stored || stored.size !== asset.size) fail(422, 'upload_batch_file_missing', '上传文件尚未完整保存'); await stored.body?.cancel?.().catch(() => {}); }
      const input = { title: project.title, productName: project.productName, description: project.description, facts: project.facts || [], objective: project.objective, audience: project.audience, landingUrl: project.landingUrl, scene: project.scene };
      const inputVersion = await productionInputVersion(project, assets), sealedAt = new Date().toISOString();
      const updatedBatch = await repo.updateJob(userId, batch.id, { status: 'sealed', details: { ...batch.details, assetIds: sortedIds(assetIds), input, inputVersion, sealedAt } });
      const updated = await repo.updateProject(userId, project.id, { sourceState: { version: 1, status: 'sealed', batchId: batch.id, assetIds: sortedIds(assetIds), inputVersion, sealedAt, startedJobId: null } });
      return { batch: publicBatch(updatedBatch), project: updated };
    });
  }
  async function configure(projectId, spec) {
    const project = await getProject(projectId), productionSpec = normalizeProductionSpec(spec);
    return { project: await repo.updateProject(userId, project.id, { productionSpec }), productionSpec };
  }
  async function start(projectId, options = {}) {
    let project = await getProject(projectId), batchId = options.batchId || project.sourceState?.batchId;
    // Existing unbatched projects can explicitly freeze their saved files once.
    if (!batchId) {
      const assets = await repo.listAssets(userId, project.id); checkAssets(assets, project.id, 64 * 1024 * 1024);
      const created = await beginBatch(project.id, { expectedCount: assets.length, reuseAssetIds: assets.map(a => a.id) });
      await completeBatch(project.id, created.batch.id, { assetIds: assets.map(a => a.id) }); batchId = created.batch.id;
    }
    if (!batchId) fail(409, 'production_batch_required', '请先完成上传批次，再开始优化');
    return locked(projectId, batchId, async batch => {
      project = await getProject(projectId);
      const optimizationTaskId = options.optimizationTaskId || null;
      if (optimizationTaskId && !id(optimizationTaskId)) fail(400, 'invalid_optimization_task', '优化任务标识无效');
      const optimizationTask = optimizationTaskId ? await repo.getOptimizationTask(userId, optimizationTaskId) : null;
      if (optimizationTaskId && (!id(optimizationTaskId) || !optimizationTask || optimizationTask.projectId !== projectId)) fail(404, 'not_found', '素材优化任务不存在');
      const requestKey = optimizationTaskId || 'initial';
      const spec = normalizeProductionSpec(options.productionSpec || project.productionSpec || {});
      const inputs = await resolveProductionInputs({ repository: repo, userId, project, batchId, productionSpec: spec });
      const workflow = typeof orchestrator === 'function' ? await orchestrator() : orchestrator;
      if (!workflow?.submitProduction) fail(503, 'production_unavailable', 'BXAGI生产服务暂不可用');
      const priorRequest = batch.details.productionRequests?.[requestKey];
      const persisted = priorRequest?.productionSpec || (!optimizationTaskId ? batch.details.productionSpec : null);
      if (persisted && JSON.stringify(persisted) !== JSON.stringify(spec)) fail(409, 'production_request_frozen', '本批生产参数已冻结，重新生成请新建批次并复用素材');
      let result;
      const existingJobId = priorRequest?.jobId || (!optimizationTaskId ? batch.details.startedJobId : optimizationTask?.metadata?.remoteJobId);
      if (existingJobId) {
        const job = await repo.getJob(userId, existingJobId);
        if (!job || job.projectId !== projectId || job.details?.batchId !== batchId || (optimizationTaskId && job.details?.optimizationTaskId !== optimizationTaskId)) fail(409, 'production_job_missing', '原生产请求需要核对，不能重复派发');
        if (JSON.stringify(job.details.productionSpec) !== JSON.stringify(spec)) fail(409, 'production_request_frozen', '本轮优化参数已冻结，请创建新的生产请求');
        result = { provider: 'bxagi', queued: true, project, job, assignment: project.assignment, variants: [], reused: true };
      } else {
        const requests = batch.details.productionRequests || {};
        if (!Object.hasOwn(requests, requestKey) && Object.keys(requests).length >= 32) fail(409, 'production_request_limit', '本批生产版本已达上限，请复用素材新建批次');
        await repo.updateJob(userId, batch.id, { details: { ...batch.details, ...(!optimizationTaskId ? { productionSpec: spec } : {}), productionRequests: { ...requests, [requestKey]: { productionSpec: spec } }, startRequestedAt: batch.details.startRequestedAt || new Date().toISOString() } });
        result = await workflow.submitProduction(project, { batchId, assetIds: inputs.assets.map(a => a.id), productionSpec: spec, inputVersion: inputs.inputVersion, ...(optimizationTaskId ? { optimizationTaskId } : {}) });
        if (!result?.job?.id) fail(503, 'production_job_missing', '员工任务尚未完成登记');
        const current = await getBatch(projectId, batchId);
        await repo.updateJob(userId, batch.id, { details: { ...current.details, ...(!optimizationTaskId ? { startedJobId: result.job.id } : {}), productionRequests: { ...current.details.productionRequests, [requestKey]: { productionSpec: spec, jobId: result.job.id } } } });
      }
      const sourceState = { version: 1, status: 'started', batchId, assetIds: inputs.assets.map(a => a.id), inputVersion: inputs.inputVersion, sealedAt: batch.details.sealedAt, startedJobId: result.job.id };
      const updated = await repo.updateProject(userId, projectId, { productionSpec: spec, sourceState });
      let automationWarning = null;
      try { if (ensureAutomation) await ensureAutomation(projectId); } catch { automationWarning = '员工任务已保存，自动进度连接暂未完成，请刷新后继续检查。'; }
      // Never turn a successful queue write into a retry invitation because a refresh failed.
      const details = { ...result.job.details }; delete details.operationId; delete details.operationExpiresAt;
      return { ...result, job: { ...result.job, details }, project: updated, ...(automationWarning ? { automationWarning } : {}) };
    });
  }
  return { beginBatch, assertBatchUpload, completeBatch, configure, start };
}
