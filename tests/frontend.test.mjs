import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createController } from '../legacy/workspace/app/controller.mjs';
import { createApiClient, endpoint, normalizeBaseUrl } from '../legacy/workspace/app/api-client.mjs';
import { createHashRouter, pageFromHash } from '../legacy/workspace/app/routing.mjs';
import { createPlanningStore, PLANNING_KEY } from '../legacy/workspace/app/planning.mjs';
import { validateWorkspace, emptyWorkspace, WORKSPACE_KEY } from '../legacy/workspace/app/workspace.mjs';
import { jobsHtml, workflowStepper } from '../legacy/workspace/app/ui.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const storage = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key,value) => data.set(key,value) }; };
const transcript = '1\n00:00:00,000 --> 00:00:04,000\n一句完整的说明。';
function harness(options = {}) {
  const localStorage = options.storage || storage();
  const sessionStorage = storage();
  const app = { innerHTML: '', dataset: {}, listeners: [], contains: () => true, addEventListener(type, fn) { this.listeners.push({ type, fn }); } };
  const fields = new Map();
  const document = { activeElement: null, getElementById: id => id === 'app' ? app : fields.get(id) || null, querySelector: () => null };
  const callbacks = new Map();
  const window = { location: { hash: '#overview' }, addEventListener: (name,fn) => callbacks.set(name,fn), removeEventListener: name => callbacks.delete(name), scrollTo() {} };
  const notices = [];
  const controller = createController({ document, window, localStorage, sessionStorage, toast: text => notices.push(text), confirmDialog: async () => true,
    inspectVideo: options.inspectVideo || (async () => ({ duration: 8, width: 320, height: 240, url: 'blob:sample' })),
    api: options.api || (async path => path === '/api/jobs' ? { jobs: [] } : { service: 'BXAGI', ffmpeg: true }),
  });
  return { controller, app, fields, callbacks, window, localStorage, sessionStorage, notices };
}
function sourceFixture() {
  return { ...emptyWorkspace(), asset: { name: 'a.mp4', duration: 8, width: 320, height: 240, size: 123 }, srt: transcript,
    clipPlans: [{ id: 'clip-a', title: '有效片段', start: 0, end: 4, selected: true }] };
}

test('planning values, format, model choice and SRT draft survive asynchronous page rerenders', async () => {
  const health = deferred();
  const { controller } = harness({ api: () => health.promise });
  Object.assign(controller.state.planning, { count: 7, minDuration: 10, maxDuration: 90, strategy: 'selling', format: 'portrait', useAi: true, advancedOpen: true });
  controller.state.srtDraft = '<script>unsaved draft</script>';
  controller.state.page = 'studio';
  const check = controller.checkHealth();
  health.resolve({ service: 'BXAGI', ffmpeg: true, llm_configured: true });
  assert.equal(await check, true);
  const html = controller.renderPage('studio');
  assert.match(html, /id="clip-count"[^>]+value="7"/);
  assert.match(html, /id="clip-min"[^>]+value="10"/);
  assert.match(html, /value="portrait" selected/);
  assert.match(html, /value="selling" selected/);
  assert.match(html, /id="use-ai"[^>]+checked/);
  assert.match(html, /&lt;script&gt;unsaved draft&lt;\/script&gt;/);
  assert.equal(controller.getWorkspace().srt, '');
});

test('valid nonsecret planning preferences restore after reload; partial invalid input keeps last valid preferences', () => {
  const store = storage();
  const first = harness({ storage: store }).controller;
  Object.assign(first.state.planning, { count: 9, minDuration: 8, maxDuration: 70, strategy: 'narrative', format: 'square', advancedOpen: true, useAi: true });
  first.render();
  const reloaded = harness({ storage: store }).controller;
  assert.equal(reloaded.state.planning.count, 9);
  assert.equal(reloaded.state.planning.format, 'square');
  assert.equal(reloaded.state.planning.advancedOpen, true);
  assert.equal(reloaded.state.planning.useAi, false);
  reloaded.state.planning.count = '';
  reloaded.render();
  assert.equal(createPlanningStore(store).current.count, 9);
  assert.ok(!store.getItem(PLANNING_KEY).includes('useAi'));
  assert.equal(store.getItem(WORKSPACE_KEY), null);
});

test('hash deep links and native Back/Forward route through one listener', () => {
  const callbacks = new Map(), pages = [];
  const window = { location: { hash: '#studio' }, addEventListener: (name,fn) => callbacks.set(name,fn), removeEventListener: name => callbacks.delete(name) };
  const router = createHashRouter({ window, onNavigate: page => pages.push(page) });
  router.start();
  assert.deepEqual(pages, ['studio']);
  router.navigate('insights');
  callbacks.get('hashchange')();
  assert.deepEqual(pages, ['studio','insights']);
  window.location.hash = '#studio'; callbacks.get('hashchange')();
  assert.deepEqual(pages, ['studio','insights','studio']);
  assert.equal(pageFromHash('#not-a-page'), 'overview');
  router.stop(); assert.equal(callbacks.size, 0);
});

test('root delegation is registered once while renders add no click handlers', async () => {
  const { controller, app } = harness();
  controller.start(); controller.render(); controller.render();
  assert.equal(app.listeners.filter(listener => listener.type === 'click').length, 1);
  assert.equal(app.listeners.filter(listener => listener.type === 'change').length, 1);
  assert.equal(app.listeners.filter(listener => listener.type === 'timeupdate').length, 1);
  await Promise.resolve(); controller.destroy();
});

test('an old health response cannot replace a more recent health check', async () => {
  const old = deferred(), recent = deferred(); let calls = 0;
  const { controller } = harness({ api: () => ++calls === 1 ? old.promise : recent.promise });
  const first = controller.checkHealth(), second = controller.checkHealth();
  recent.resolve({ service: 'new', llm_configured: true });
  assert.equal(await second, true);
  old.resolve({ service: 'old', llm_configured: false });
  assert.equal(await first, false);
  assert.equal(controller.state.backend.llmConfigured, true);
  assert.match(controller.state.backend.detail, /new/);
});

test('authenticated service health verifies the protected API before reporting readiness', async () => {
  const { controller, notices } = harness({ api: async path => {
    if(path === '/api/health') return { service:'BXAGI', auth_required:true };
    if(path === '/api/capabilities') throw new Error('令牌无效');
    return {jobs:[]};
  } });
  assert.equal(await controller.checkHealth(true), false);
  assert.equal(controller.state.backend.healthy, false);
  assert.ok(notices.some(message => /API 令牌/.test(message)));
  controller.state.backend.token = 'wrong';
  assert.equal(await controller.checkHealth(true), false);
  assert.equal(controller.state.backend.healthy, false);
  assert.ok(notices.some(message => /令牌无效/.test(message)));
});

test('API rejects dangerous base URLs and handles timeout/cancellation with actionable errors', async () => {
  assert.equal(normalizeBaseUrl('https://example.com/service/'), 'https://example.com/service');
  for(const url of ['javascript:alert(1)','https://user:secret@example.com','https://example.com?token=secret']) assert.throws(() => normalizeBaseUrl(url));
  assert.throws(() => endpoint('', '//other.example/api/jobs'));
  let fireTimeout;
  const client = createApiClient({ getConnection: () => ({url:'',token:'',revision:0}),
    fetch: (url,{signal}) => new Promise((resolve,reject) => signal.addEventListener('abort',() => reject(new DOMException('Aborted','AbortError')),{once:true})),
    setTimer: fn => { fireTimeout = fn; return 1; }, clearTimer() {},
  });
  const timedOut = client.request('/api/health'); fireTimeout();
  await assert.rejects(timedOut, /请求超时/);
  const controller = new AbortController();
  const cancelled = client.request('/api/jobs', { signal:controller.signal }); controller.abort();
  await assert.rejects(cancelled, {name:'AbortError'});
});

test('credentials are captured once and stale parsed API responses are rejected after connection change', async () => {
  const parsed = deferred(); const connection={url:'https://api.example.com',token:'private',revision:0}; let authorization;
  const client = createApiClient({ getConnection: () => connection, fetch: async (url,options) => {
    authorization=options.headers.Authorization;
    return {ok:true,headers:{get:()=> 'application/json'},json:()=>parsed.promise};
  } });
  const request=client.request('/api/health');
  connection.token='new'; connection.revision=1;
  parsed.resolve({service:'old'});
  await assert.rejects(request,/配置已更换/);
  assert.equal(authorization,'Bearer private');
});

test('late ASR results from a replaced source cannot overwrite its subtitle', async () => {
  const result=deferred(), started=deferred();
  const {controller}=harness({api:async path => {
    if(path.endsWith('/transcribe')){started.resolve();return result.promise;}
    return {id:'asset-a'};
  }});
  controller.replaceWorkspace(sourceFixture());
  controller.state.backend.healthy=true;controller.state.backend.asrConfigured=true;
  controller.state.file={name:'a.mp4',size:123};controller.state.serverAssetId='asset-a';
  const transcribing=controller.transcribeServer();
  await started.promise;
  await controller.selectVideo({name:'b.mp4',size:123});
  result.resolve({srt:transcript});
  await assert.rejects(transcribing,/旧请求结果已忽略/);
  assert.equal(controller.getWorkspace().asset.name,'b.mp4');
  assert.equal(controller.getWorkspace().srt,'');
});

test('strict migration rejects oversized IDs before truncation can collide', () => {
  const raw=sourceFixture();raw.clipPlans[0].id='x'.repeat(101);
  assert.throws(()=>validateWorkspace(raw),/记录 ID/);
});

test('queue filtering and campaign search show only matching real records', () => {
  const {controller}=harness();
  controller.state.jobs=[{id:'job-active',title:'进行中的任务',status:'running'},{id:'job-done',title:'完成的任务',status:'passed',output_url:'/video'}];
  controller.state.queueFilter='active';
  const html=jobsHtml(controller.state);
  assert.match(html,/进行中的任务/);assert.ok(!html.includes('完成的任务'));
  const raw=emptyWorkspace();raw.campaigns=[{id:'campaign-a',name:'秋季广告',dailyBudget:100,targetRoi:2,maxDailyBudget:500,minSpend:100,status:'paused'},{id:'campaign-b',name:'夏季广告',dailyBudget:100,targetRoi:2,maxDailyBudget:500,minSpend:100,status:'paused'}];
  controller.replaceWorkspace(raw);controller.state.campaignSearch='秋季';
  const campaigns=controller.renderPage('campaigns');assert.match(campaigns,/秋季广告/);assert.ok(!campaigns.includes('夏季广告'));
});

test('native frontend import graph resolves without bare imports or external dependencies', async () => {
  const root=new URL('../legacy/workspace/',import.meta.url);
  const visited=new Set();
  async function walk(url){
    if(visited.has(url.href))return;visited.add(url.href);
    const source=fs.readFileSync(url,'utf8');
    for(const match of source.matchAll(/\bimport\s+(?:[^;]+?\s+from\s+)?['"]([^'"]+)['"]/g)){
      assert.ok(match[1].startsWith('.'), `External frontend dependency ${match[1]}`);
      const dependency=new URL(match[1],url);assert.ok(fs.existsSync(dependency),`Missing ${dependency.pathname}`);await walk(dependency);
    }
  }
  await walk(new URL('app.js',root));
  assert.ok(visited.size>=18);
});


test('production progress belongs to the current source rather than unrelated completed jobs', () => {
  const {controller}=harness();controller.replaceWorkspace(sourceFixture());
  controller.state.file={name:'a.mp4',size:123};controller.state.serverAssetId='asset-a';
  controller.state.jobs=[{id:'old-job',asset_id:'other-asset',status:'passed',output_url:'/video'}];
  const unrelated=workflowStepper({workspace:controller.getWorkspace(),state:controller.state});
  assert.match(unrelated,/下一步：生产已选片段/);
  controller.state.jobs.push({id:'source-job',asset_id:'asset-a',status:'passed',output_url:'/video'});
  const completed=workflowStepper({workspace:controller.getWorkspace(),state:controller.state});
  assert.match(completed,/下一步：查看素材验收/);
});
