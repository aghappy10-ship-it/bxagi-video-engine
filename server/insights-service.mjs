import { buildInsights, reportAttribution, reportCurrency } from '../components/platform/insights.mjs';

const error = (message, status = 400, code = 'insights_invalid_action') => Object.assign(new Error(message), { status, code });
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const clean = (value, max = 600) => String(value || '').trim().slice(0, max);
const fingerprint = value => {
  let hash = 2166136261;
  for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
};

/** Deterministic recommendations with persisted evidence, never ad execution authority. */
export function createInsightsService({ repository, now = () => new Date() }) {
  async function dataFor(userId) {
    if (!userId) throw error('请先登录 BXAGI 账户', 401, 'authentication_required');
    const [projects, campaigns, metrics, assets, creatives] = await Promise.all([
      repository.listProjects(userId), repository.listCampaigns(userId), repository.listMetrics(userId),
      repository.listAssets(userId), repository.listCreatives(userId),
    ]);
    return { projects, campaigns, metrics, assets, creatives };
  }
  const period = () => ({ from: new Date(now().getTime() - 29 * 86400000).toISOString().slice(0, 10), to: now().toISOString().slice(0, 10), currency: 'CNY' });
  function filtersOf(filters = {}) {
    for (const key of ['from', 'to']) if (filters[key] && !validDate(filters[key])) throw error('请选择有效的报表日期');
    if (filters.from && filters.to && filters.from > filters.to) throw error('开始日期不能晚于结束日期');
    return filters;
  }
  async function overview(userId, filters = {}) { return buildInsights(await dataFor(userId), filtersOf(filters)); }
  async function audit(userId, action, entityType, entityId, details) { await repository.addAudit?.(userId, { action, entityType, entityId, details }); }

  async function getActiveStrategyGuidance(userId, { projectId } = {}) {
    const strategies = (await repository.listStrategies(userId)).filter(row => row.status === 'active' && (!row.projectId || row.projectId === projectId)).slice(0, 6);
    return { strategyIds: strategies.map(row => row.id), productionGuidance: strategies.filter(row => row.kind === 'material').map(row => clean(row.definition?.guidance)), deliveryGuidance: strategies.filter(row => row.kind === 'delivery').map(row => clean(row.definition?.guidance)), authority: 'advisory' };
  }

  async function recommendations(userId, { refresh = false } = {}) {
    const data = await dataFor(userId), window = period(), overview = buildInsights(data, window);
    let decisions = await repository.listDecisions(userId);
    if (!refresh) return { decisions, overview };
    if (data.metrics.length >= 10000 || ['projects', 'assets', 'creatives', 'campaigns'].some(key => data[key].length >= 500)) throw error('素材包、文件、投放单元或日报数量达到当前读取上限，当前数据可能不完整；请完成分页汇总后再生成经营建议。', 409, 'insights_data_truncated');
    const activeStrategies = (await repository.listStrategies(userId)).filter(row => row.status === 'active');
    const candidates = [];
    const add = (type, title, reason, scope, actionPlan, report) => {
      const campaignIds = scope.campaignId ? [scope.campaignId] : data.campaigns.filter(row => !scope.projectId || row.projectId === scope.projectId).map(row => row.id);
      const metricRows = overview.snapshots.filter(row => campaignIds.includes(row.campaignId));
      const evidence = { window, currency: 'CNY', metricIds: metricRows.map(row => row.id).filter(Boolean), campaignIds, report, attribution: [...new Set(metricRows.map(reportAttribution))], lastDate: metricRows.map(row => row.date).sort().at(-1) || null, generatedAt: now().toISOString(), activeStrategyIds: activeStrategies.filter(row => !row.projectId || row.projectId === scope.projectId).map(row => row.id), method: '规则分析；相关性观察，不作效果保证', thresholds: { minDays: 3, minConversions: 10 }, key: '' };
      evidence.key = fingerprint([type, scope, metricRows.map(row => [row.id, row.updatedAt, row.spend, row.revenue, row.dataFresh]), actionPlan]);
      candidates.push({ ...scope, type, title, reason, status: 'proposed', evidence, actionPlan, result: {} });
    };
    if (!overview.count && data.campaigns.length) add('data_quality', '先补齐投放反馈，再判断经营方向', '近 30 天尚无可用日报，暂时无法判断素材、渠道或预算分配的效果。', {}, { kind: 'collect_data', instructions: '在投放中心同步渠道报表，或补充已核实的每日消耗、归因收入与转化。' }, { count: 0 });
    if (overview.count && (overview.coverage < 1 || overview.freshCount < overview.count || !overview.comparable)) add('data_quality', '补齐归因数据与报表口径', `${overview.knownCount}/${overview.count} 条日报具备收入字段，${overview.freshCount}/${overview.count} 条已确认新鲜。${!overview.comparable ? '存在不同归因口径。' : ''}当前数据不宜直接用于自动扩大预算。`, {}, { kind: 'collect_data', instructions: '核对缺失转化、报表更新时间和归因窗口，再评估预算调整。' }, { count: overview.count, coverage: overview.coverage, comparable: overview.comparable });
    for (const project of data.projects) {
      const assets = data.assets.filter(row => row.projectId === project.id), creatives = data.creatives.filter(row => row.projectId === project.id && !['rejected', 'failed'].includes(row.status));
      if (assets.length && !creatives.length) add('material', `为「${project.title}」完成首批可投放成品`, `已有 ${assets.length} 份原始资料，尚无可用成品；优先完成生产，建立可比较的素材版本。`, { projectId: project.id }, { kind: 'optimization_task', instructions: '基于已上传素材与真实产品信息生产首批成品；突出可核实卖点，保留版本差异，不编造功效。' }, { assetCount: assets.length, creativeCount: 0 });
    }
    for (const summary of overview.byCampaign) {
      const campaign = data.campaigns.find(row => row.id === summary.id), target = Number(campaign?.targetRoi);
      if (summary.days < 3 || summary.conversions == null || summary.conversions < 10 || summary.coverage < 1 || summary.freshCount < summary.count || summary.roi == null || !(target > 0)) continue;
      const report = { spend: summary.spend, revenue: summary.revenue, roi: summary.roi, targetRoi: target, conversions: summary.conversions, days: summary.days, count: summary.count };
      if (summary.roi < target) add('material', `复盘「${summary.name}」的素材与转化路径`, `观察期 ${summary.days} 天、${summary.conversions} 次归因转化，投产比 ${summary.roi.toFixed(2)} 低于设置目标 ${target.toFixed(2)}。先检查素材表达、落地页及受众匹配，结论仍需新一轮验证。`, { projectId: summary.projectId, campaignId: summary.id }, { kind: 'optimization_task', instructions: `以当前素材为基线，围绕一个明确变量生成新版本；检查卖点、前段吸引力与落地页一致性。保留原版本作对照。目标投产比 ${target}，不得声称新版本一定改善。` }, report);
      else add('delivery', `复核「${summary.name}」的预算承接能力`, `观察期投产比 ${summary.roi.toFixed(2)}，达到设置目标 ${target.toFixed(2)}；先检查转化质量与持续性，再决定是否重新分配包内预算。`, { projectId: summary.projectId, campaignId: summary.id }, { kind: 'budget_draft', instructions: '保持素材包预算上限，复核归因和订单质量；如确认持续达标，在投放中心明确调整各单元额度。', currentDailyBudget: Number(campaign.dailyBudget) || 0, proposedDailyBudget: null }, report);
    }
    if (overview.byProject.length >= 2 && overview.spend > 0) {
      const largest = overview.byProject[0], share = largest.spend / overview.spend;
      if (share >= .7) add('delivery', '复核跨素材包的预算分配', `「${largest.name}」占当前窗口消耗 ${(share * 100).toFixed(1)}%。集中投入本身不代表低效，可结合业务目标和完整归因数据决定是否分配测试额度。`, { projectId: largest.projectId }, { kind: 'budget_draft', instructions: '对照各包的投放目标、消耗和归因覆盖，制定预算分配草案；任何增加总额度的动作需单独确认。', proposedDailyBudget: null }, { spend: overview.spend, projectSpend: largest.spend, share, projectCount: overview.byProject.length });
    }
    for (const candidate of candidates.slice(0, 40)) {
      if (decisions.some(row => row.evidence?.key === candidate.evidence.key)) continue;
      // A pending recommendation is replaced only when its data-backed evidence changes.
      const existing = decisions.find(row => row.status === 'proposed' && row.type === candidate.type && row.title === candidate.title && (row.projectId || '') === (candidate.projectId || '') && (row.campaignId || '') === (candidate.campaignId || ''));
      const saved = existing ? await repository.updateDecision(userId, existing.id, candidate) : await repository.createDecision(userId, candidate);
      decisions = [saved, ...decisions.filter(row => row.id !== saved.id)];
    }
    return { decisions, overview };
  }

  async function updateDecision(userId, id, { action } = {}) {
    let decision = await repository.getDecision(userId, id);
    if (!decision) throw error('经营建议不存在', 404, 'not_found');
    if (!['accept', 'dismiss'].includes(action)) throw error('不支持的决策操作');
    const status = action === 'accept' ? 'accepted' : 'dismissed';
    if (decision.status === status) return { decision };
    if (!['proposed', `processing_${action}`].includes(decision.status)) throw error('该建议已经处理，请根据新数据生成新的建议', 409);
    if (repository.claimDecisionAction) {
      decision = await repository.claimDecisionAction(userId, id, action);
      if (!decision) throw error('该建议正在处理，请稍后刷新确认', 409, 'decision_busy');
    }
    try {
      let result = { kind: decision.actionPlan?.kind || 'review', recordedAt: now().toISOString(), execution: 'not_started' };
      if (action === 'accept' && decision.actionPlan?.kind === 'optimization_task') {
        if (!decision.projectId || !await repository.getProject(userId, decision.projectId)) throw error('关联素材包不存在', 404, 'not_found');
        const payload = { projectId: decision.projectId, campaignId: decision.campaignId || '', type: 'creative_optimization', status: 'pending', reason: decision.actionPlan.instructions, metadata: { sourceDecisionId: id, evidence: decision.evidence, instructions: decision.actionPlan.instructions, origin: 'business_decision', approval: 'accepted' } };
        let task;
        if (repository.createDecisionOptimizationTask) task = await repository.createDecisionOptimizationTask(userId, payload);
        else {
          const tasks = await repository.listOptimizationTasks(userId);
          task = tasks.find(row => row.metadata?.sourceDecisionId === id) || await repository.addOptimizationTask(userId, payload);
        }
        result = { ...result, optimizationTaskId: task.id, execution: 'task_created' };
      } else if (action === 'accept' && decision.actionPlan?.kind === 'budget_draft') result = { ...result, execution: 'draft_only', instructions: decision.actionPlan.instructions };
      const saved = await repository.updateDecision(userId, id, { status, result });
      await audit(userId, `decision_${action}`, 'decision', id, { result });
      return { decision: saved };
    } catch (cause) {
      if (repository.claimDecisionAction) {
        const current = await repository.getDecision(userId, id);
        if (current?.status === `processing_${action}`) await repository.updateDecision(userId, id, { status: 'proposed' });
      }
      throw cause;
    }
  }

  async function createStrategy(userId, { decisionId, name } = {}) {
    const decision = await repository.getDecision(userId, decisionId);
    if (!decision || decision.status !== 'accepted') throw error('请先采纳对应的经营建议');
    if (!['material', 'delivery'].includes(decision.type)) throw error('数据补齐提醒不能直接转成生产或投放策略');
    const all = await repository.listStrategies(userId), existing = all.find(row => row.sourceDecisionId === decision.id && row.status !== 'rolled_back');
    if (existing) return { strategy: existing };
    const strategyName = clean(name || decision.title, 100);
    const version = Math.max(0, ...all.filter(row => row.name === strategyName).map(row => Number(row.version) || 0)) + 1;
    const strategy = await repository.createStrategy(userId, { projectId: decision.projectId || null, campaignId: decision.campaignId || null, name: strategyName, version, kind: decision.type, status: 'hypothesis', sourceDecisionId: decision.id, definition: { guidance: clean(decision.actionPlan?.instructions), authority: 'advisory', budgetAuthority: false, launchAuthority: false }, evidence: { baseline: decision.evidence, createdAt: now().toISOString(), validation: null } });
    await audit(userId, 'strategy_created', 'strategy', strategy.id, { sourceDecisionId: decision.id });
    return { strategy };
  }

  async function updateStrategy(userId, id, { action, notes } = {}) {
    const strategy = await repository.getStrategy(userId, id);
    if (!strategy) throw error('策略记录不存在', 404, 'not_found');
    let patch;
    if (action === 'validate') {
      if (strategy.status !== 'hypothesis') throw error('仅待验证策略可以更新验证结果', 409);
      const baseline = strategy.evidence?.baseline || {}, start = strategy.evidence?.createdAt?.slice(0, 10), data = await dataFor(userId);
      const report = buildInsights(data, { projectId: strategy.projectId || undefined, from: start, to: now().toISOString().slice(0, 10), currency: baseline.currency || 'CNY' });
      const later = report.snapshots.filter(row => row.date > (baseline.lastDate || start) && row.dataFresh === true);
      const eligible = buildInsights({ ...data, metrics: later }, { currency: baseline.currency || 'CNY' });
      if (eligible.days < 3 || eligible.conversions == null || eligible.conversions < 10 || eligible.coverage < 1 || !eligible.comparable || eligible.roi == null) throw error('验证需要基线日期之后至少 3 个报表日、10 次归因转化，以及完整、同口径的真实收入数据；当前继续观察。', 409, 'strategy_insufficient_evidence');
      if (!clean(notes, 1000)) throw error('请记录本轮实际实施的改动与观察结论');
      if (baseline.attribution?.length && !eligible.attribution.every(value => baseline.attribution.includes(value))) throw error('本轮与基线归因口径不同，不能直接验证', 409, 'strategy_incomparable_evidence');
      patch = { status: 'validated', evidence: { ...strategy.evidence, validation: { observedAt: now().toISOString(), notes: clean(notes, 1000), metricIds: later.map(row => row.id), currency: reportCurrency(later[0]), attribution: eligible.attribution, days: eligible.days, conversions: eligible.conversions, spend: eligible.spend, revenue: eligible.revenue, roi: eligible.roi, causalEffectVerified: false, interpretation: '已核对后续真实报表；效果相关性不等同于因果证明。' } } };
    } else if (action === 'activate') {
      if (strategy.status === 'active') return { strategy };
      if (strategy.status !== 'validated' || !strategy.evidence?.validation?.metricIds?.length) throw error('请先完成真实报表验证，再发布策略参考', 409, 'strategy_not_validated');
      patch = { status: 'active', definition: { ...strategy.definition, activatedAt: now().toISOString(), authority: 'advisory', budgetAuthority: false, launchAuthority: false } };
    } else if (action === 'rollback') {
      if (!['active', 'validated', 'hypothesis'].includes(strategy.status)) throw error('当前策略已回退', 409);
      patch = { status: 'rolled_back', definition: { ...strategy.definition, rolledBackAt: now().toISOString(), rollbackNotes: clean(notes, 1000) } };
    } else throw error('不支持的策略操作');
    const saved = await repository.updateStrategy(userId, id, patch);
    await audit(userId, `strategy_${action}`, 'strategy', id, { from: strategy.status, to: patch.status });
    return { strategy: saved };
  }
  return { overview, recommendations, updateDecision, createStrategy, updateStrategy, getActiveStrategyGuidance };
}
