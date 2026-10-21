/* Actual imported state, page and controller regressions. Media execution uses injected adapters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../legacy/workspace/app/controller.mjs';
import { validateWorkspace } from '../legacy/workspace/app/workspace.mjs';
import { parseCsv, csvNumber } from '../legacy/workspace/app/imports.mjs';

const transcript = '1\n00:00:00,000 --> 00:00:02,000\n第一句完整说明。\n\n2\n00:00:02,000 --> 00:00:04,000\n第二句包含价格信息。';
const day = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const campaign = () => ({ id: 'campaign-one', name: '测试计划', dailyBudget: 100, targetRoi: 2, maxDailyBudget: 1000, minSpend: 100, status: 'paused', demo: false });
const fixture = () => ({ version: 1, asset: { name: 'fixture.mp4', duration: 8, width: 320, height: 240, size: 1234 }, srt: transcript, clipPlans: [{ id: 'clip-one', title: '已保存的手动计划', start: 0, end: 4, text: '完整说明。', selected: true }], campaigns: [campaign()], metrics: [], events: [], demo: false });
const metric = (date, spend, overrides = {}) => ({ id: `metric-${date}`, campaignId: 'campaign-one', spend, revenue: 0, conversions: null, hasConversion: false, dataFresh: true, source: '报表.csv', date, importedAt: new Date().toISOString(), demo: false, ...overrides });

function harness() {
  const records = new Map(), calls = [], notices = [];
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
  const app = { innerHTML: '' };
  const document = { getElementById: id => id === 'app' ? app : null };
  const controller = createController({ document,
    window: { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, scrollTo() {} },
    localStorage: storage, sessionStorage: storage, toast: message => notices.push(message),
    confirmDialog: async () => true,
    inspectVideo: async () => ({ duration: 8, width: 320, height: 240, url: 'blob:review-only' }),
    renderBrowserClip: async () => { throw new Error('Media is intentionally not exercised in this Node test'); },
    api: async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      if(path === '/api/jobs' && options.method === 'POST') return { id: 'job-review', status: 'queued' };
      if(path === '/api/jobs') return { jobs: [] };
      return { segments: [] };
    },
  });
  const review = {
    ...controller, validateWorkspace, parseCsv, csvNumber,
    setWorkspace: raw => controller.replaceWorkspace(raw),
    pages: Object.fromEntries(['overview','studio','quality','campaigns','insights','products','settings'].map(page => [page, () => controller.renderPage(page)])),
    prepareService() { controller.state.backend.healthy = true; controller.state.file = { name:'fixture.mp4', size:1234 }; controller.state.serverAssetId = 'asset-review'; },
  };
  return { review, calls, notices, records };
}

test('workspace restore rejects malformed budgets and invalid conversion counts before they become ROI', () => {
  const { review } = harness();
  const invalidBudget = fixture(); invalidBudget.campaigns[0].dailyBudget = 'wrong';
  assert.throws(() => review.validateWorkspace(invalidBudget), /数值无效/);
  const invalidConversion = fixture(); invalidConversion.metrics = [metric(day(), 60, { revenue: 120, conversions: -1, hasConversion: true })];
  assert.throws(() => review.validateWorkspace(invalidConversion), /无效金额、转化数/);
  const validUnknown = fixture(); validUnknown.metrics = [metric(day(), 60, { revenue: 120 })];
  review.setWorkspace(validUnknown);
  assert.equal(review.totals().hasConversion, false);
  assert.equal(review.totals().conversions, null);
  assert.equal(review.totals().roi, null);
});

test('oversize workspace collections fail explicitly instead of silently truncating user records', () => {
  const { review } = harness();
  for (const [key, count] of [['clipPlans', 201], ['campaigns', 1001], ['metrics', 20001], ['events', 201]]) {
    const data = fixture(); data[key] = Array.from({ length: count }, () => ({}));
    assert.throws(() => review.validateWorkspace(data), /超过容量/, key);
  }
});

test('daily budget recommendations use only the current latest report day, while Insights keeps totals', () => {
  const { review } = harness();
  const data = fixture(); data.metrics = [metric(day(-1), 60), metric(day(), 60)];
  review.setWorkspace(data);
  const c = review.getWorkspace().campaigns[0];
  assert.equal(review.campaignMetric(c).spend, 120);
  assert.equal(review.budgetMetric(c).spend, 60);
  assert.equal(review.advice(c).action, 'hold');
  assert.equal(review.advice(c).period, day());
});

test('stale or undated metric reports cannot recommend a budget increase', () => {
  const { review } = harness();
  for (const date of [day(-1), '']) {
    const data = fixture(); data.metrics = [metric(date, 150, { revenue: 600, conversions: 8, hasConversion: true })];
    review.setWorkspace(data);
    assert.equal(review.advice(review.getWorkspace().campaigns[0]).action, 'hold');
  }
});

test('all seven templates render strings in empty and populated state with untrusted labels escaped', () => {
  const { review } = harness();
  for (const [name, template] of Object.entries(review.pages)) assert.ok(template().includes('<'), `Empty ${name}`);
  const data = fixture(); data.clipPlans[0].title = '<img src=x onerror=alert(1)>'; data.campaigns[0].name = '<script>untrusted</script>';
  data.metrics = [metric(day(), 150, { revenue: 300, conversions: 4, hasConversion: true })];
  review.setWorkspace(data);
  for (const [name, template] of Object.entries(review.pages)) {
    const html = template(); assert.ok(html.includes('<'), `Populated ${name}`);
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), `Escaped clip in ${name}`);
    assert.ok(!html.includes('<script>untrusted</script>'), `Escaped campaign in ${name}`);
  }
});

test('reattaching the original source preserves restored edits; choosing a different source clears old subtitle', async () => {
  const { review } = harness(); review.setWorkspace(fixture());
  await review.selectVideo({ name: 'fixture.mp4', size: 1234 });
  assert.equal(review.getWorkspace().clipPlans.length, 1);
  assert.equal(review.getWorkspace().clipPlans[0].title, '已保存的手动计划');
  assert.equal(review.getWorkspace().srt, transcript);
  await review.selectVideo({ name: 'different.mp4', size: 1234 });
  assert.equal(review.getWorkspace().clipPlans.length, 0);
  assert.equal(review.getWorkspace().srt, '');
});

test('official queue submission uses selected clips without an unrelated planning request', async () => {
  const { review, calls } = harness(); review.setWorkspace(fixture()); review.prepareService();
  await review.submitQueue();
  assert.ok(calls.some(call => call.path === '/api/jobs' && call.method === 'POST'));
  assert.ok(!calls.some(call => call.path.endsWith('/plan')));
  const job = calls.find(call => call.path === '/api/jobs' && call.method === 'POST');
  assert.equal(job.body.clips[0].start, 0); assert.equal(job.body.clips[0].end, 4);
});

test('CSV parser handles quotes and missing conversion stays unknown; reimport is rejected', async () => {
  const { review, notices } = harness(); review.setWorkspace(fixture());
  const input = `campaign,spend,revenue,conversions,date\n"测试计划",60,120,,${day()}\n`;
  const file = { name: 'report.csv', size: input.length, text: async () => input };
  await review.importCsv(file);
  assert.equal(review.getWorkspace().metrics.length, 1);
  assert.equal(review.getWorkspace().metrics[0].hasConversion, false);
  assert.equal(review.totals().roi, null);
  await review.importCsv(file);
  assert.equal(review.getWorkspace().metrics.length, 1);
  assert.ok(notices.some(message => /拒绝重复导入/.test(message)));
  assert.equal(review.parseCsv('a,b\n"quoted, value","double ""quote"""')[1][1], 'double "quote"');
});
