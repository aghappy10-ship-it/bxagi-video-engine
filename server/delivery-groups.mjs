import { AdsError } from './adapters/provider-http.mjs';
import { assertCreativeDeliveryComplete } from './creative-delivery-eligibility.mjs';

const invalid = (message, code = 'invalid_delivery_group', status = 400) => { throw new AdsError(code, message, { status }); };
const owns = (row, userId) => row && (!row.userId || row.userId === userId);
const cents = (value, label = '预算') => {
  const n = Number(value), rounded = Math.round(n * 100);
  if (!Number.isFinite(n) || n <= 0 || !Number.isSafeInteger(rounded) || Math.abs(n * 100 - rounded) > 0.000001) invalid(`${label}须为大于零且最多两位小数的金额`, 'invalid_budget');
  return rounded;
};
const amount = value => value / 100;
const pendingWrite = row => row.status === 'needs_reconciliation' || !!row.remoteState?.writePending;
const publicFailure = error => ({ code: error instanceof AdsError ? error.code : 'delivery_operation_failed', message: error instanceof AdsError ? error.message : '该素材的操作未完成，请查看任务记录后重试' });
// Financial checks must use the complete group, never the paginated dashboard list.
const groupCampaigns = async (repo, userId, groupId) => typeof repo.listCampaignsByGroup === 'function'
  ? repo.listCampaignsByGroup(userId, groupId)
  : (await repo.listCampaigns(userId)).filter(row => row.deliveryGroupId === groupId);

export function allocateDeliveryBudgets(creativeIds, { dailyBudget, totalBudget, maxDailyBudget, allocations, groupDailyBudgetCap } = {}) {
  if (!Array.isArray(creativeIds) || !creativeIds.length || creativeIds.length > 20 || new Set(creativeIds).size !== creativeIds.length || creativeIds.some(id => typeof id !== 'string' || !id.trim())) invalid('请选择 1 至 20 条不重复的成品', 'invalid_creatives');
  const daily = cents(dailyBudget, '素材包日预算'), total = cents(totalBudget, '素材包总预算');
  if (total < daily) invalid('素材包总预算不能低于日预算', 'invalid_budget');
  if (daily < creativeIds.length || total < creativeIds.length) invalid('预算不足以为每条素材分配至少 0.01 元', 'invalid_budget');
  if (allocations !== undefined && (!Array.isArray(allocations) || allocations.length !== creativeIds.length || new Set(allocations.map(a => a?.creativeId)).size !== creativeIds.length || allocations.some(a => !creativeIds.includes(a?.creativeId)))) invalid('自定义分配必须与所选成品逐条对应', 'invalid_allocations');
  const split = (value, i) => Math.floor(value / creativeIds.length) + (i < value % creativeIds.length ? 1 : 0);
  const rows = creativeIds.map((creativeId, i) => {
    const provided = allocations?.find(a => a.creativeId === creativeId);
    const d = provided ? cents(provided.dailyBudget) : split(daily, i);
    const t = provided ? cents(provided.totalBudget) : split(total, i);
    const maximum = cents(provided?.maxDailyBudget ?? maxDailyBudget ?? dailyBudget, '单条每日上限');
    if (d > maximum || maximum > cents(groupDailyBudgetCap ?? dailyBudget) || t < d) invalid('单条预算须不超过单条上限及素材包日上限，且总预算不得低于日预算', 'invalid_allocations');
    return { creativeId, dailyBudget: amount(d), totalBudget: amount(t), maxDailyBudget: amount(maximum) };
  });
  if (rows.reduce((s, r) => s + cents(r.dailyBudget), 0) > daily || rows.reduce((s, r) => s + cents(r.totalBudget), 0) > total) invalid('子素材预算合计超过素材包预算', 'delivery_group_budget_exceeded');
  return rows;
}

async function ownedGroup(repo, userId, groupId) {
  if (!userId || !groupId || typeof repo.getDeliveryGroup !== 'function') invalid('素材包投放项目不存在', 'not_found', 404);
  const group = await repo.getDeliveryGroup(userId, groupId);
  if (!owns(group, userId)) invalid('素材包投放项目不存在', 'not_found', 404);
  return group;
}

/** Lock order is always group, then campaign. Callbacks must not reacquire this lock. */
export async function withDeliveryGroupLock(repo, userId, groupId, callback) {
  if (!groupId) return callback(null);
  await ownedGroup(repo, userId, groupId);
  if (typeof repo.claimDeliveryGroupOperation !== 'function' || typeof repo.releaseDeliveryGroupOperation !== 'function') invalid('素材包预算锁暂不可用', 'delivery_group_lock_unavailable', 503);
  const operationId = crypto.randomUUID();
  const group = await repo.claimDeliveryGroupOperation(userId, groupId, operationId);
  if (!owns(group, userId)) invalid('素材包正在执行另一项预算或投放操作，请稍后重试', 'delivery_group_busy', 409);
  try { return await callback(group); }
  finally { await repo.releaseDeliveryGroupOperation(userId, groupId, operationId); }
}

/** Caller holds the group lock. Drafts and paused units reserve their allocations too. */
export async function assertDeliveryGroupAllocation(repo, userId, campaign, proposed = {}) {
  if (!campaign.deliveryGroupId) return null;
  const group = await ownedGroup(repo, userId, campaign.deliveryGroupId);
  if (group.projectId !== campaign.projectId || !owns(campaign, userId)) invalid('投放单元与素材包归属不匹配', 'invalid_delivery_unit', 409);
  const siblings = await groupCampaigns(repo, userId, group.id);
  if (siblings.some(row => !owns(row, userId) || row.projectId !== group.projectId || row.creativeIds?.length !== 1)) invalid('素材包投放单元关联不完整，请先核对', 'invalid_delivery_unit', 409);
  const own = siblings.find(row => row.id === campaign.id);
  if (!own) invalid('投放单元不存在', 'not_found', 404);
  const next = { ...own, ...proposed };
  const nextDaily = cents(next.dailyBudget), nextTotal = cents(next.totalBudget);
  if (nextTotal < nextDaily || nextDaily > cents(next.maxDailyBudget)) invalid('单条预算超过允许范围', 'invalid_budget');
  const increasing = nextDaily > cents(own.dailyBudget) || nextTotal > cents(own.totalBudget);
  if ((increasing || !Object.keys(proposed).length) && siblings.some(pendingWrite)) invalid('包内有待核对的渠道写入，本次不能启动或扩大预算', 'delivery_group_reconciliation_required', 409);
  const daily = siblings.reduce((sum, row) => sum + (row.id === own.id ? nextDaily : cents(row.dailyBudget)), 0);
  const total = siblings.reduce((sum, row) => sum + (row.id === own.id ? nextTotal : cents(row.totalBudget)), 0);
  if (daily > cents(group.dailyBudget) || total > cents(group.totalBudget)) invalid('调整后子素材预算合计超过素材包上限，请先调整包内分配', 'delivery_group_budget_exceeded', 409);
  return { group, dailyBudget: amount(daily), totalBudget: amount(total), availableDailyBudget: amount(cents(group.dailyBudget) - daily) };
}

export function deliveryGroupStatus(campaigns = []) {
  if (!campaigns.length) return 'draft';
  const states = new Set(campaigns.map(row => row.status));
  if (campaigns.some(pendingWrite)) return 'needs_reconciliation';
  if (states.has('active')) return states.size === 1 ? 'active' : 'partial';
  if (states.has('launching')) return 'launching';
  if (states.size === 1) return campaigns[0].status;
  return 'partial';
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
async function fingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function hasSecret(value) {
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => /(?:secret|token|password|api.?key|authorization)/i.test(key) || hasSecret(item));
}
function assertAddedAllocations(group, existing, pending) {
  const all = [...existing, ...pending];
  if (all.reduce((sum, row) => sum + cents(row.dailyBudget), 0) > cents(group.dailyBudget) || all.reduce((sum, row) => sum + cents(row.totalBudget), 0) > cents(group.totalBudget)) invalid('包内剩余分配额度不足，请先降低原有子素材额度或调整素材包上限', 'delivery_group_budget_exceeded', 409);
  if (existing.some(pendingWrite)) invalid('包内有待核对的渠道写入，暂不能增加投放单元', 'delivery_group_reconciliation_required', 409);
}

export function createDeliveryGroupService({ repository: repo, env = {}, assertCreativeEligible = assertCreativeDeliveryComplete } = {}) {
  const units = (u, g) => groupCampaigns(repo, u, g);
  async function create(userId, input = {}) {
    const project = await repo.getProject(userId, input.projectId);
    if (!owns(project, userId)) invalid('素材包不存在', 'not_found', 404);
    const plan = allocateDeliveryBudgets(input.creativeIds, input);
    if (cents(input.dailyBudget) > cents(Number(env.APP_MAX_DAILY_BUDGET) || 1000)) invalid('素材包日预算超过平台上限', 'invalid_budget');
    if (!['oceanengine', 'kuaishou', 'tencent', 'custom'].includes(input.channel)) invalid('不支持该投放渠道', 'invalid_channel');
    const connection = await repo.getConnection(userId, input.connectionId);
    if (!owns(connection, userId) || connection.channel !== input.channel || connection.status === 'disabled') invalid('请选择当前用户已保存且未停用的同渠道账户', 'connection_missing');
    const config = input.platformConfig ?? {};
    if (!config || Array.isArray(config) || typeof config !== 'object' || hasSecret(config)) invalid('渠道配置须为对象，凭证请在账户设置中保存', 'unsafe_credentials');
    const targetRoi = Number(input.targetRoi ?? 1);
    if (!Number.isFinite(targetRoi) || targetRoi <= 0 || targetRoi > 1000) invalid('目标 ROI 不在允许范围内', 'invalid_target_roi');
    const creatives = [];
    for (const allocation of plan) {
      const creative = await repo.getCreative(userId, allocation.creativeId);
      if (!owns(creative, userId) || creative.projectId !== project.id || !/^(image|video)\//.test(creative.mimeType ?? '') || ['cover', 'thumbnail', 'notes', 'subtitle', 'auxiliary'].includes(creative.deliverableRole ?? creative.metadata?.deliverableRole)) invalid('所选成品须属于当前素材包，且不能是封面或说明附件', 'invalid_creative');
      await assertCreativeEligible({ repository: repo, userId, creative });
      creatives.push(creative);
    }
    const objective = input.objective || project.objective || 'views';
    if (!['purchase', 'install', 'lead', 'views'].includes(objective)) invalid('不支持该投放目标', 'invalid_objective');
    const definition = { projectId: project.id, channel: input.channel, connectionId: connection.id, dailyBudget: Number(input.dailyBudget), totalBudget: Number(input.totalBudget), plan, objective, targetRoi, autoOptimize: input.autoOptimize === true, platformConfig: config };
    const signature = await fingerprint(definition);
    let group = await repo.getDeliveryGroupByProject(userId, project.id);
    if (!group) {
      try {
        group = await repo.createDeliveryGroup(userId, { projectId: project.id, name: String(input.name || `${project.title}投放`).slice(0, 180), dailyBudget: Number(input.dailyBudget), totalBudget: Number(input.totalBudget), status: 'draft', policy: { creationSignature: signature, creativeIds: plan.map(row => row.creativeId), channel: input.channel, connectionId: connection.id, autoOptimize: definition.autoOptimize, allocations: plan }, operationId: null });
      } catch (error) {
        group = await repo.getDeliveryGroupByProject(userId, project.id);
        if (!group) throw error;
      }
    }
    return withDeliveryGroupLock(repo, userId, group.id, async locked => {
      if (locked.projectId !== project.id || locked.policy?.creationSignature !== signature) invalid('该素材包已有投放项目，请在现有项目中管理预算和成品', 'delivery_group_exists', 409);
      let campaigns = await units(userId, group.id);
      const missing = plan.filter(allocation => !campaigns.some(row => row.creativeIds?.length === 1 && row.creativeIds[0] === allocation.creativeId && row.connectionId === connection.id && row.channel === input.channel));
      assertAddedAllocations(locked, campaigns, missing);
      const results = [];
      for (const allocation of plan) {
        const existing = campaigns.find(row => row.creativeIds?.length === 1 && row.creativeIds[0] === allocation.creativeId && row.connectionId === connection.id && row.channel === input.channel);
        if (existing) { results.push({ creativeId: allocation.creativeId, campaignId: existing.id, status: existing.status, existing: true, ok: true }); continue; }
        const creative = creatives.find(row => row.id === allocation.creativeId);
        try {
          const campaign = await repo.createCampaign(userId, { projectId: project.id, deliveryGroupId: group.id, unitKey: `${group.id}:${creative.id}:${connection.id}:1`, creativeIds: [creative.id], name: `${locked.name} · ${creative.title || creative.filename}`.slice(0, 180), channel: input.channel, connectionId: connection.id, dailyBudget: allocation.dailyBudget, totalBudget: allocation.totalBudget, maxDailyBudget: allocation.maxDailyBudget, targetRoi, objective: definition.objective, autoOptimize: definition.autoOptimize, platformConfig: config, buyingEmployeeId: '', status: 'draft', remoteState: { deliveryUnit: { initialDailyBudget: allocation.dailyBudget, initialTotalBudget: allocation.totalBudget, creativeId: creative.id, sourceVersion: creative.variantId || creative.id, round: 1, creationSignature: signature } } });
          campaigns.push(campaign);
          results.push({ creativeId: creative.id, campaignId: campaign.id, status: 'draft', ok: true });
        } catch (error) { results.push({ creativeId: allocation.creativeId, ok: false, ...publicFailure(error) }); }
      }
      const partial = results.some(row => !row.ok);
      group = await repo.updateDeliveryGroup(userId, group.id, { status: partial ? 'draft_partial' : deliveryGroupStatus(campaigns) });
      await repo.addAudit(userId, { action: 'delivery_group.drafts_created', entityType: 'deliveryGroup', entityId: group.id, details: { partial, campaignIds: campaigns.map(row => row.id), dailyBudget: group.dailyBudget, totalBudget: group.totalBudget } });
      return { group, campaigns, results, partial };
    });
  }
  /** Explicit new rounds/accounts never alter running creative versions. */
  async function append(userId, groupId, input = {}) {
    const initialGroup = await ownedGroup(repo, userId, groupId);
    const project = await repo.getProject(userId, initialGroup.projectId);
    if (!owns(project, userId)) invalid('素材包不存在', 'not_found', 404);
    const round = Number(input.versionRound ?? 1), requestId = input.requestId;
    if (!Number.isSafeInteger(round) || round < 1 || round > 1000000 || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) invalid('新增批次需要有效轮次和稳定的请求编号', 'invalid_delivery_round');
    const plan = allocateDeliveryBudgets(input.creativeIds, { ...input, maxDailyBudget: input.maxDailyBudget ?? initialGroup.dailyBudget, groupDailyBudgetCap: initialGroup.dailyBudget });
    if (!['oceanengine', 'kuaishou', 'tencent', 'custom'].includes(input.channel)) invalid('不支持该投放渠道', 'invalid_channel');
    const connection = await repo.getConnection(userId, input.connectionId);
    if (!owns(connection, userId) || connection.channel !== input.channel || connection.status === 'disabled') invalid('请选择当前用户已保存且未停用的同渠道账户', 'connection_missing');
    const config = input.platformConfig ?? {}, objective = input.objective || project.objective || 'views', targetRoi = Number(input.targetRoi ?? 1);
    if (!config || Array.isArray(config) || typeof config !== 'object' || hasSecret(config)) invalid('渠道配置须为对象，凭证请在账户设置中保存', 'unsafe_credentials');
    if (!['purchase', 'install', 'lead', 'views'].includes(objective) || !Number.isFinite(targetRoi) || targetRoi <= 0 || targetRoi > 1000) invalid('投放目标或 ROI 设置不正确', 'invalid_objective');
    const creatives = [];
    for (const allocation of plan) {
      const creative = await repo.getCreative(userId, allocation.creativeId);
      if (!owns(creative, userId) || creative.projectId !== project.id || !/^(image|video)\//.test(creative.mimeType ?? '') || ['cover', 'thumbnail', 'notes', 'subtitle', 'auxiliary'].includes(creative.deliverableRole ?? creative.metadata?.deliverableRole)) invalid('所选成品须属于当前素材包，且不能是封面或说明附件', 'invalid_creative');
      await assertCreativeEligible({ repository: repo, userId, creative }); creatives.push(creative);
    }
    const signature = await fingerprint({ groupId, requestId, round, channel: input.channel, connectionId: connection.id, plan, config, objective, targetRoi, autoOptimize: input.autoOptimize === true });
    return withDeliveryGroupLock(repo, userId, groupId, async group => {
      let campaigns = await units(userId, groupId);
      const existingRequest = campaigns.filter(row => row.remoteState?.deliveryUnit?.requestId === requestId);
      if (existingRequest.some(row => row.remoteState.deliveryUnit.creationSignature !== signature)) invalid('同一请求编号不能用于不同的投放配置', 'delivery_request_conflict', 409);
      const keyFor = creativeId => `${groupId}:${creativeId}:${connection.id}:${round}`;
      for (const allocation of plan) {
        const existing = campaigns.find(row => row.unitKey === keyFor(allocation.creativeId));
        if (existing && existing.remoteState?.deliveryUnit?.creationSignature !== signature) invalid('该成品版本在此账户和轮次已有投放，请选择新轮次或管理原投放', 'delivery_unit_exists', 409);
      }
      const missing = plan.filter(row => !campaigns.some(c => c.unitKey === keyFor(row.creativeId)));
      assertAddedAllocations(group, campaigns, missing);
      const results = [];
      for (const allocation of plan) {
        const existing = campaigns.find(row => row.unitKey === keyFor(allocation.creativeId));
        if (existing) { results.push({ creativeId: allocation.creativeId, campaignId: existing.id, status: existing.status, existing: true, ok: true }); continue; }
        const creative = creatives.find(row => row.id === allocation.creativeId);
        try {
          const campaign = await repo.createCampaign(userId, { projectId: project.id, deliveryGroupId: groupId, unitKey: keyFor(creative.id), creativeIds: [creative.id], name: `${group.name} · ${creative.title || creative.filename} · 第${round}轮`.slice(0, 180), channel: input.channel, connectionId: connection.id, dailyBudget: allocation.dailyBudget, totalBudget: allocation.totalBudget, maxDailyBudget: allocation.maxDailyBudget, targetRoi, objective, autoOptimize: input.autoOptimize === true, platformConfig: config, buyingEmployeeId: '', status: 'draft', remoteState: { deliveryUnit: { initialDailyBudget: allocation.dailyBudget, initialTotalBudget: allocation.totalBudget, creativeId: creative.id, sourceVersion: creative.variantId || creative.id, round, requestId, creationSignature: signature } } });
          campaigns.push(campaign); results.push({ creativeId: creative.id, campaignId: campaign.id, status: 'draft', ok: true });
        } catch (error) { results.push({ creativeId: creative.id, ok: false, ...publicFailure(error) }); }
      }
      const partial = results.some(row => !row.ok);
      const updated = await repo.updateDeliveryGroup(userId, groupId, { status: partial ? 'draft_partial' : deliveryGroupStatus(campaigns) });
      await repo.addAudit(userId, { action: 'delivery_group.units_added', entityType: 'deliveryGroup', entityId: groupId, details: { requestId, versionRound: round, partial, results: results.map(row => ({ campaignId: row.campaignId, creativeId: row.creativeId, ok: row.ok })) } });
      return { group: updated, campaigns, results, partial };
    });
  }
  async function updateBudget(userId, groupId, input = {}) {
    return withDeliveryGroupLock(repo, userId, groupId, async group => {
      const daily = cents(input.dailyBudget), total = cents(input.totalBudget);
      if (total < daily || daily > cents(Number(env.APP_MAX_DAILY_BUDGET) || 1000)) invalid('素材包预算不在允许范围内', 'invalid_budget');
      const campaigns = await units(userId, group.id);
      if (campaigns.some(pendingWrite)) invalid('包内存在待核对的渠道操作，暂不能修改预算', 'delivery_group_reconciliation_required', 409);
      if (campaigns.reduce((s, c) => s + cents(c.dailyBudget), 0) > daily || campaigns.reduce((s, c) => s + cents(c.totalBudget), 0) > total) invalid('包上限不能低于已分配的子素材预算，请先调整子素材额度', 'delivery_group_budget_exceeded', 409);
      const updated = await repo.updateDeliveryGroup(userId, group.id, { dailyBudget: amount(daily), totalBudget: amount(total) });
      await repo.addAudit(userId, { action: 'delivery_group.budget_updated', entityType: 'deliveryGroup', entityId: group.id, details: { before: { dailyBudget: group.dailyBudget, totalBudget: group.totalBudget }, after: { dailyBudget: updated.dailyBudget, totalBudget: updated.totalBudget }, appliesTo: 'allocation_cap_only' } });
      return { group: updated, campaigns };
    });
  }
  /** The injected callback must call the existing employee workflow. No spend is authorized here. */
  async function operate(userId, groupId, action, executeCampaign) {
    const group = await ownedGroup(repo, userId, groupId);
    if (!['launch', 'pause', 'sync'].includes(action) || typeof executeCampaign !== 'function') invalid('不支持该投放操作', 'invalid_operation');
    const campaigns = await units(userId, groupId), results = [];
    for (const campaign of campaigns) {
      if (!owns(campaign, userId) || campaign.projectId !== group.projectId) invalid('投放单元归属不匹配', 'invalid_delivery_unit', 409);
      try {
        const result = await executeCampaign(campaign, action);
        const row = result?.campaign || result;
        const queued = result?.queued === true || result?.provider === 'bxagi' && !!result?.job;
        const failed = !queued && (row?.error || ['blocked', 'failed', 'needs_reconciliation'].includes(row?.status));
        results.push({ campaignId: campaign.id, creativeId: campaign.creativeIds?.length === 1 ? campaign.creativeIds[0] : null, ok: !failed, queued, status: queued ? 'queued' : row?.status || 'submitted', ...(failed ? { message: row.error || '该素材操作尚未完成' } : {}), ...(queued && result.job?.id ? { jobId: result.job.id } : {}) });
      } catch (error) { results.push({ campaignId: campaign.id, ok: false, ...publicFailure(error) }); }
    }
    const current = await units(userId, groupId);
    return { group: { ...group, status: deliveryGroupStatus(current) }, campaigns: current, results, partial: results.some(row => !row.ok) && results.some(row => row.ok) };
  }
  return { create, append, updateBudget, operate };
}
