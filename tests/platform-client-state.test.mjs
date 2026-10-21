import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformClientState } from '../components/platform/client-state.mjs';
import { normalizeSessionBootstrap } from '../components/platform/auth-state.mjs';
import { subscribeClientSessionChange, notifyClientSessionChange } from '../components/platform/client-session-events.mjs';

const EMPTY = { user: { id: '' }, bxagi: { connected: false }, projects: [], assets: [], creatives: [], jobs: [], automationFlows: [], capabilities: {} };
const workspace = owner => ({ ...EMPTY, user: { id: owner }, bxagi: { connected: true }, projects: [{ id: `${owner}-private-project` }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const reads = [], writes = [], pendingReads = [], pendingWrites = [];
  let owner = 'owner-a';
  const store = createPlatformClientState({ empty: EMPTY,
    request: async (path, options) => { reads.push({ path, options }); return pendingReads.length ? pendingReads.shift().promise : workspace(owner); },
    post: async (path, data) => { writes.push({ path, data }); return pendingWrites.length ? pendingWrites.shift().promise : { connected: false }; },
  });
  return { store, reads, writes, pendingReads, pendingWrites, owner: value => { owner = value; } };
}

test('overlapping refresh callers share one read and all receive the verified workspace', async () => {
  const f = fixture(), response = deferred(); f.pendingReads.push(response);
  const first = f.store.refresh(), second = f.store.refresh();
  assert.equal(f.reads.length, 1); assert.equal(first, second);
  response.resolve(workspace('owner-a'));
  assert.equal((await first).user.id, 'owner-a'); assert.equal((await second).user.id, 'owner-a');
  assert.equal(f.store.getSnapshot().loading, false); assert.equal(f.store.getSnapshot().requiresLogin, false);
});

test('two clicks before a render submit once and a second operation cannot clear its busy state', async () => {
  const f = fixture(); await f.store.refresh(); let submitted = 0;
  const result = deferred(), first = f.store.run('create-project', () => { submitted++; return result.promise; }, '已创建');
  assert.equal(await f.store.run('create-project', async () => { submitted++; }), undefined);
  assert.equal(await f.store.run('launch-campaign', async () => { submitted++; }), undefined);
  assert.equal(await f.store.advanceAutomation(), undefined);
  assert.equal(submitted, 1); assert.equal(f.store.getSnapshot().busy, 'create-project');
  result.resolve({ id: 'saved-project' });
  assert.deepEqual(await first, { id: 'saved-project' }); assert.equal(f.store.getSnapshot().busy, '');
  assert.equal(f.store.getSnapshot().notice, '已创建'); assert.equal(f.writes.length, 0);
});

test('a successful mutation stays successful when only its follow-up refresh fails and is never replayed', async () => {
  const f = fixture(); await f.store.refresh(); let submitted = 0;
  const refresh = deferred(); f.pendingReads.push(refresh);
  const action = f.store.run('upload', async () => { submitted++; return { asset: 'saved' }; }, '文件已保存');
  await turn(); refresh.reject(Object.assign(new Error('upstream unavailable'), { status: 503 }));
  assert.deepEqual(await action, { asset: 'saved' }); assert.equal(submitted, 1);
  assert.equal(f.store.getSnapshot().notice, '文件已保存'); assert.match(f.store.getSnapshot().error, /工作区状态暂未更新/);
  assert.equal(f.store.getSnapshot().data.user.id, 'owner-a'); assert.equal(f.store.getSnapshot().busy, '');
});

test('writes discard reads started before submission and refresh from a new server snapshot', async () => {
  const f = fixture(); await f.store.refresh(); const old = deferred(); f.pendingReads.push(old);
  const staleRead = f.store.refresh();
  const saved = await f.store.run('new-project', async () => { f.owner('owner-a'); return { id: 'new' }; });
  assert.equal(saved.id, 'new'); assert.equal(f.reads[1].options.signal.aborted, true);
  old.resolve(workspace('stale-owner')); assert.equal(await staleRead, EMPTY);
  assert.equal(f.store.getSnapshot().data.user.id, 'owner-a');
});

test('confirmed login invalidates old reads before the new account loads', async () => {
  const f = fixture(); await f.store.refresh(); const old = deferred(); f.pendingReads.push(old);
  const staleRead = f.store.refresh();
  const unsubscribe = subscribeClientSessionChange(f.store.sessionChanged);
  try {
    notifyClientSessionChange(); assert.equal(f.store.getSnapshot().data, EMPTY);
    f.owner('owner-b'); await f.store.refresh();
    old.resolve(workspace('owner-a')); await staleRead;
    assert.equal(f.store.getSnapshot().data.user.id, 'owner-b');
    assert.equal(f.store.getSnapshot().data.projects[0].id, 'owner-b-private-project');
  } finally { unsubscribe(); }
});

test('old account operations cannot return data, clear new busy state, publish notices or log out the new account', async () => {
  for (const lateFailure of [false, true]) {
    const f = fixture(); await f.store.refresh(); const old = deferred();
    const oldRun = f.store.run('old-save', () => old.promise, '旧账号操作成功');
    f.store.sessionChanged(); f.owner('owner-b'); await f.store.refresh();
    const next = deferred(), newRun = f.store.run('new-save', () => next.promise, '新账号操作成功');
    if (lateFailure) old.reject(Object.assign(new Error('old session expired'), { status: 401 }));
    else old.resolve({ privateResult: 'owner-a' });
    assert.equal(await oldRun, undefined);
    assert.equal(f.store.getSnapshot().busy, 'new-save'); assert.equal(f.store.getSnapshot().error, '');
    assert.equal(f.store.getSnapshot().notice, ''); assert.equal(f.store.getSnapshot().data.user.id, 'owner-b');
    next.resolve({ id: 'owner-b-result' }); assert.deepEqual(await newRun, { id: 'owner-b-result' });
    assert.equal(f.store.getSnapshot().notice, '新账号操作成功');
  }
});

test('a server-detected account switch also invalidates an earlier operation without a local login event', async () => {
  const f = fixture(); await f.store.refresh(); const old = deferred();
  const action = f.store.run('old-save', () => old.promise, '旧提示');
  f.owner('owner-b'); await f.store.refresh(); old.resolve({ oldResult: true });
  assert.equal(await action, undefined); assert.equal(f.store.getSnapshot().data.user.id, 'owner-b');
  assert.equal(f.store.getSnapshot().notice, ''); assert.equal(f.store.getSnapshot().busy, '');
});

test('logout immediately invalidates reads and prevents a refresh from restoring the pending old session', async () => {
  const f = fixture(); await f.store.refresh(); const old = deferred(), logout = deferred();
  f.pendingReads.push(old); f.pendingWrites.push(logout);
  const reading = f.store.refresh(), leaving = f.store.logoutBxagi(), reads = f.reads.length;
  assert.equal(f.store.getSnapshot().data, EMPTY); assert.equal(await f.store.refresh(), EMPTY);
  assert.equal(f.reads.length, reads); assert.equal(await f.store.logoutBxagi(), undefined); assert.equal(f.writes.length, 1);
  old.resolve(workspace('owner-a')); await reading; assert.equal(f.store.getSnapshot().data, EMPTY);
  logout.resolve({ connected: false }); await leaving;
  assert.equal(f.store.getSnapshot().requiresLogin, true); assert.equal(f.store.getSnapshot().busy, '');
});

test('a refused logout restores only a fresh verified snapshot and reports failure', async () => {
  const f = fixture(); await f.store.refresh(); const logout = deferred(); f.pendingWrites.push(logout);
  const leaving = f.store.logoutBxagi(); logout.reject(new Error('退出服务暂不可用')); await leaving;
  assert.equal(f.store.getSnapshot().data.user.id, 'owner-a'); assert.equal(f.store.getSnapshot().requiresLogin, false);
  assert.equal(f.store.getSnapshot().error, '退出服务暂不可用'); assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 2);
});

test('automatic ticks do not overlap and user writes wait for the current tick without replaying it', async () => {
  const f = fixture(); await f.store.refresh(); const tick = deferred(); f.pendingWrites.push(tick);
  const advancing = f.store.advanceAutomation(); assert.equal(await f.store.advanceAutomation(), undefined);
  let submitted = false; const saving = f.store.run('save', async () => { submitted = true; return { saved: true }; });
  assert.equal(submitted, false); assert.equal(f.store.getSnapshot().busy, 'save');
  tick.resolve({ processed: 1 }); await advancing; assert.deepEqual(await saving, { saved: true });
  assert.equal(submitted, true); assert.equal(f.writes.length, 1);
});

test('late tick and unmounted reads cannot restore private data or report stale errors', async () => {
  const f = fixture(); await f.store.refresh(); const tick = deferred(); f.pendingWrites.push(tick);
  const advancing = f.store.advanceAutomation(); f.store.sessionChanged(); const count = f.reads.length;
  tick.reject(Object.assign(new Error('old account unauthorized'), { status: 401 })); await advancing;
  assert.equal(f.reads.length, count); assert.equal(f.store.getSnapshot().data, EMPTY); assert.equal(f.store.getSnapshot().error, '');
  const read = deferred(); f.pendingReads.push(read); const pending = f.store.refresh(); f.store.disconnect();
  read.resolve(workspace('old-owner')); await pending; assert.equal(f.store.getSnapshot().data, EMPTY);
  f.owner('owner-b'); f.store.connect(); await turn(); assert.equal(f.store.getSnapshot().data.user.id, 'owner-b'); assert.equal(f.store.getSnapshot().loading, false);
});

test('employee-service outages preserve verified login, malformed collection fields cannot crash the workspace', async () => {
  const result = normalizeSessionBootstrap({ user: { id: 'owner-a' }, bxagi: { connected: false, status: 'unavailable' }, projects: null, assets: 'bad', capabilities: [] }, EMPTY);
  assert.equal(result.authenticated, true); assert.equal(result.data.bxagi.connected, false);
  assert.deepEqual(result.data.projects, []); assert.deepEqual(result.data.assets, []); assert.deepEqual(result.data.capabilities, {});
  assert.equal(normalizeSessionBootstrap({ bxagi: { status: 'unavailable' } }, EMPTY).authenticated, false);
});
