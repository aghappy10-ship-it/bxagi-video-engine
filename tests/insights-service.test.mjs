import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights } from '../components/platform/insights.mjs';
import { createInsightsService } from '../server/insights-service.mjs';

const USER = 'tenant-a';
const metric = (id, campaignId, date, spend, revenue, extra = {}) => ({ id, campaignId, projectId: 'pack-a', date, spend, revenue, conversions: 5, hasConversion: revenue != null, dataFresh: true, source: 'oceanengine', updatedAt: `${date}T12:00:00Z`, ...extra });
function fixture() {
    const data = { projects: [{ id: 'pack-a', title: '眼镜' }], campaigns: [{ id: 'campaign-a', projectId: 'pack-a', name: '眼镜 A', channel: 'oceanengine', targetRoi: 2, dailyBudget: 100 }], metrics: [], assets: [{ id: 'asset-a', projectId: 'pack-a' }], creatives: [{ id: 'creative-a', projectId: 'pack-a', status: 'approved' }], decisions: [], strategies: [], tasks: [], audit: [] };
    const list = key => async u => u === USER ? structuredClone(data[key]) : [];
    const get = key => async (u, id) => u === USER ? structuredClone(data[key].find(row => row.id === id) || null) : null;
    const create = key => async (u, payload) => { assert.equal(u, USER); const row = { id: `${key}-${data[key].length + 1}`, userId: u, ...structuredClone(payload) }; data[key].push(row); return structuredClone(row); };
    const update = key => async (u, id, patch) => { assert.equal(u, USER); const row = data[key].find(row => row.id === id); Object.assign(row, structuredClone(patch)); return structuredClone(row); };
    const repo = { listProjects: list('projects'), listCampaigns: list('campaigns'), listMetrics: list('metrics'), listAssets: list('assets'), listCreatives: list('creatives'), listDecisions: list('decisions'), listStrategies: list('strategies'), getProject: get('projects'), getDecision: get('decisions'), getStrategy: get('strategies'), createDecision: create('decisions'), updateDecision: update('decisions'), createStrategy: create('strategies'), updateStrategy: update('strategies'), listOptimizationTasks: list('tasks'), addOptimizationTask: create('tasks'), addAudit: create('audit') };
    repo.claimDecisionAction = async (u, id, action) => { const row = u === USER && data.decisions.find(row => row.id === id); if (!row || row.status !== 'proposed') return null; row.status = `processing_${action}`; return structuredClone(row); };
    repo.createDecisionOptimizationTask = async (u, payload) => { const existing = data.tasks.find(row => row.metadata?.sourceDecisionId === payload.metadata.sourceDecisionId); return existing || repo.addOptimizationTask(u, payload); };
    return { data, repo, service: createInsightsService({ repository: repo, now: () => new Date('2026-10-15T12:00:00Z') }) };
}

test('global reporting deduplicates daily snapshots and calculates weighted return', () => {
    const campaigns = [{ id: 'a', projectId: 'p1', channel: 'oceanengine' }, { id: 'b', projectId: 'p2', channel: 'tencent' }];
    const report = buildInsights({ campaigns, metrics: [metric('a1', 'a', '2026-10-01', 100, 200), metric('a-manual', 'a', '2026-10-01', 900, 9000, { source: 'manual' }), metric('b1', 'b', '2026-10-01', 900, 900)] });
    assert.equal(report.count, 2); assert.equal(report.spend, 1000); assert.equal(report.roi, 1.1); assert.equal(report.byProject.length, 2);
    assert.equal(buildInsights({ campaigns, metrics: report.snapshots }, { channel: 'tencent' }).spend, 900);
});

test('missing revenue stays unknown, mixed currency and foreign unit reports never enter CNY aggregate', () => {
    const campaigns = [{ id: 'a', projectId: 'p' }];
    const report = buildInsights({ campaigns, metrics: [metric('a', 'a', '2026-10-01', 100, 200), metric('b', 'a', '2026-10-02', 100, null), metric('usd', 'a', '2026-10-03', 50, 100, { metadata: { currency: 'USD' } }), metric('foreign', 'other', '2026-10-03', 1000, 10000)] });
    assert.equal(report.spend, 200); assert.equal(report.knownRevenue, 200); assert.equal(report.revenue, null); assert.equal(report.roi, null); assert.equal(report.coverage, .5);
});

test('different attribution windows suppress combined return without hiding known spend', () => {
    const report = buildInsights({ campaigns: [{ id: 'a' }], metrics: [metric('a', 'a', '2026-10-01', 100, 200, { metadata: { attributionWindow: '1d' } }), metric('b', 'a', '2026-10-02', 100, 400, { metadata: { attributionWindow: '7d' } })] });
    assert.equal(report.spend, 200); assert.equal(report.roi, null); assert.equal(report.comparable, false);
});

test('recommendations use real evidence and preserve acceptance when refreshed with identical data', async () => {
    const { data, service } = fixture();
    data.metrics.push(...['2026-10-10', '2026-10-11', '2026-10-12'].map((day, i) => metric(`m${i}`, 'campaign-a', day, 100, 100)));
    const first = await service.recommendations(USER, { refresh: true });
    const decision = first.decisions.find(row => row.type === 'material');
    assert.equal(decision.evidence.metricIds.length, 3);
    await service.updateDecision(USER, decision.id, { action: 'accept' });
    await service.updateDecision(USER, decision.id, { action: 'accept' });
    assert.equal(data.tasks.length, 1);
    const again = await service.recommendations(USER, { refresh: true });
    assert.equal(again.decisions.length, first.decisions.length); assert.equal(again.decisions.find(row => row.id === decision.id).status, 'accepted');
});

test('concurrent decision acceptance creates one optimization task, and other tenants cannot accept it', async () => {
    const { data, service } = fixture(); data.creatives = [];
    const { decisions } = await service.recommendations(USER, { refresh: true });
    const decision = decisions.find(row => row.type === 'material');
    await assert.rejects(() => service.updateDecision('tenant-b', decision.id, { action: 'accept' }), error => error.status === 404);
    const results = await Promise.allSettled([service.updateDecision(USER, decision.id, { action: 'accept' }), service.updateDecision(USER, decision.id, { action: 'accept' })]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(data.tasks.length, 1); assert.equal(data.tasks[0].campaignId, '');
});

test('budget recommendation acceptance only persists a draft and never changes campaign budget', async () => {
    const { data, service } = fixture();
    data.metrics.push(...['2026-10-10', '2026-10-11', '2026-10-12'].map((day, i) => metric(`m${i}`, 'campaign-a', day, 100, 300)));
    const { decisions } = await service.recommendations(USER, { refresh: true });
    const row = decisions.find(row => row.type === 'delivery');
    const { decision } = await service.updateDecision(USER, row.id, { action: 'accept' });
    assert.equal(decision.result.execution, 'draft_only'); assert.equal(data.campaigns[0].dailyBudget, 100); assert.equal(data.tasks.length, 0);
});

test('strategy validation cannot pass without later complete evidence; publication and rollback control future guidance', async () => {
    const { data, service } = fixture();
    data.metrics.push(...['2026-10-09', '2026-10-10', '2026-10-11'].map((day, i) => metric(`m${i}`, 'campaign-a', day, 100, 100)));
    const { decisions } = await service.recommendations(USER, { refresh: true }); const decision = decisions.find(row => row.type === 'material');
    await service.updateDecision(USER, decision.id, { action: 'accept' });
    const { strategy } = await service.createStrategy(USER, { decisionId: decision.id });
    await assert.rejects(() => service.updateStrategy(USER, strategy.id, { action: 'activate' }), error => error.code === 'strategy_not_validated');
    await assert.rejects(() => service.updateStrategy(USER, strategy.id, { action: 'validate', notes: '观察' }), error => error.code === 'strategy_insufficient_evidence');
    data.strategies[0].evidence.createdAt = '2026-10-11T12:00:00Z';
    data.metrics.push(...['2026-10-12', '2026-10-13', '2026-10-14'].map((day, i) => metric(`new${i}`, 'campaign-a', day, 100, 150)));
    const validated = await service.updateStrategy(USER, strategy.id, { action: 'validate', notes: '增加产品细节画面；同期受众也改变，尚不能判断因果。' });
    assert.equal(validated.strategy.evidence.validation.causalEffectVerified, false);
    await service.updateStrategy(USER, strategy.id, { action: 'activate' });
    const active = await service.getActiveStrategyGuidance(USER, { projectId: 'pack-a' }); assert.deepEqual(active.strategyIds, [strategy.id]); assert.equal(active.authority, 'advisory');
    assert.deepEqual((await service.getActiveStrategyGuidance(USER, { projectId: 'other' })).strategyIds, []);
    await service.updateStrategy(USER, strategy.id, { action: 'rollback' });
    assert.deepEqual((await service.getActiveStrategyGuidance(USER, { projectId: 'pack-a' })).strategyIds, []);
});

test('new strategy version after rollback remains a hypothesis and never inherits validation', async () => {
    const { data, service } = fixture(); data.creatives = [];
    const { decisions } = await service.recommendations(USER, { refresh: true }); const decision = decisions.find(row => row.type === 'material');
    await service.updateDecision(USER, decision.id, { action: 'accept' });
    const first = await service.createStrategy(USER, { decisionId: decision.id }); await service.updateStrategy(USER, first.strategy.id, { action: 'rollback' });
    const next = await service.createStrategy(USER, { decisionId: decision.id });
    assert.equal(next.strategy.version, 2); assert.equal(next.strategy.status, 'hypothesis'); assert.equal(next.strategy.evidence.validation, null);
});

for (const [collection, limit] of [['projects', 500], ['assets', 500], ['creatives', 500], ['campaigns', 500], ['metrics', 10000]]) {
    test(`recommendations stop before persistence when ${collection} reaches its repository read limit`, async () => {
        const { data, service } = fixture();
        const template = collection === 'metrics' ? metric('m', 'campaign-a', '2026-10-14', 100, 300) : data[collection][0];
        data[collection] = Array.from({ length: limit }, (_, index) => ({ ...template, id: `${collection}-${index}` }));
        await assert.rejects(() => service.recommendations(USER, { refresh: true }), error => error.status === 409 && error.code === 'insights_data_truncated');
        assert.equal(data.decisions.length, 0);
        assert.equal(data.tasks.length, 0);
    });
}
