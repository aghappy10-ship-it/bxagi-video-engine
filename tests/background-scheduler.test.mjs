import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { backgroundSchedulerHealth, runBackgroundTick, schedulerAuthorized } from '../server/background-scheduler.mjs';
import { handlePlatformRequest } from '../server/platform-api.mjs';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  const DB = { prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...args) { return {
    async first() { return stmt.get(...args) ?? null; }, async all() { return { results: stmt.all(...args) }; },
    async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; },
  }; } }; } };
  return { sqlite, env: { DB, BXAGI_BACKGROUND_ENABLED: 'true', BXAGI_SCHEDULER_SECRET: 'scheduler-fixture-secret-of-sufficient-length' } };
}

test('configuration, real heartbeat and freshness are independent; reads never claim running', async () => {
  const { sqlite, env } = fixture(); let clock = Date.now();
  try {
    assert.equal((await backgroundSchedulerHealth(env, clock)).status, 'unverified');
    let called = false;
    assert.equal((await runBackgroundTick({ env: { ...env, BXAGI_BACKGROUND_ENABLED: 'false' }, work: () => { called = true; } })).enabled, false);
    assert.equal(called, false);
    await runBackgroundTick({ env, now: () => clock, work: async () => ({ processed: 0 }) });
    assert.equal((await backgroundSchedulerHealth(env, clock)).status, 'running');
    assert.equal((await backgroundSchedulerHealth(env, clock + 180000)).status, 'stalled');
    assert.equal((await backgroundSchedulerHealth({ ...env, BXAGI_BACKGROUND_ENABLED: 'false' }, clock)).status, 'disabled');
    await assert.rejects(runBackgroundTick({ env, now: () => ++clock, work: async () => { throw new Error('PRIVATE_UPSTREAM_MESSAGE'); } }), /本轮未完整完成/);
    const health = await backgroundSchedulerHealth(env, clock);
    assert.equal(health.status, 'error');
    assert.ok(health.lastSuccessfulTickAt);
    assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM jobs').all()).includes('PRIVATE_UPSTREAM_MESSAGE'));
  } finally { sqlite.close(); }
});

test('overlapping ticks execute work once and completion is fenced after an expired lease', async () => {
  const { sqlite, env } = fixture(); let clock = Date.now(), release, firstCalls = 0;
  try {
    const gate = new Promise(resolve => { release = resolve; });
    const first = runBackgroundTick({ env, now: () => clock, work: async () => { firstCalls++; await gate; return { processed: 1 }; } });
    await new Promise(resolve => setImmediate(resolve));
    const second = await runBackgroundTick({ env, now: () => clock, work: async () => { throw new Error('must not run'); } });
    assert.equal(second.skipped, 'busy'); assert.equal(firstCalls, 1);
    clock += 11 * 60000;
    await runBackgroundTick({ env, now: () => clock, work: async () => ({ processed: 2 }) });
    const succeededAt = (await backgroundSchedulerHealth(env, clock)).lastSuccessfulTickAt;
    release(); await assert.rejects(first, /本轮未完整完成/);
    const health = await backgroundSchedulerHealth(env, clock);
    assert.equal(health.status, 'running'); assert.equal(health.lastSuccessfulTickAt, succeededAt);
  } finally { sqlite.close(); }
});

test('dedicated scheduler secret authorizes only fixed tick, not ordinary media worker routes', async () => {
  const { sqlite, env } = fixture(); let calls = 0;
  try {
    const request = (path, body, token = env.BXAGI_SCHEDULER_SECRET, method = 'POST') => new Request(`https://site.test/api/v2${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body } : {}),
    });
    const invoke = r => handlePlatformRequest(r, env, { backgroundWork: async () => { calls++; return { processed: 0 }; } });
    assert.equal((await invoke(request('/worker/background-tick', '{}', 'wrong'))).status, 401);
    assert.equal((await invoke(request('/worker/background-tick', '{"userId":"other"}'))).status, 400);
    assert.equal((await invoke(request('/worker/background-tick?owner=other', '{}'))).status, 400);
    assert.equal((await invoke(request('/worker/background-tick', undefined, env.BXAGI_SCHEDULER_SECRET, 'GET'))).status, 405);
    assert.equal(calls, 0);
    assert.equal((await invoke(request('/worker/background-tick', '{}'))).status, 200);
    assert.equal(calls, 1);
    assert.notEqual((await invoke(request('/worker/claim', '{}'))).status, 200);
    assert.equal(await schedulerAuthorized(request('/worker/background-tick', '{}', 'short'), { BXAGI_SCHEDULER_SECRET: 'short' }), false);
  } finally { sqlite.close(); }
});

test('default scheduler stays healthy without a configured catalog or upstream calls', async () => {
  const { sqlite, env } = fixture();
  try {
    const response = await handlePlatformRequest(new Request('https://site.test/api/v2/worker/background-tick', {
      method: 'POST', headers: { Authorization: `Bearer ${env.BXAGI_SCHEDULER_SECRET}` }, body: '{}',
    }), env, { fetcher: async () => { throw new Error('No upstream request expected'); } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.processed, 0);
    assert.equal((await backgroundSchedulerHealth(env)).status, 'running');
  } finally { sqlite.close(); }
});

test('node diagnostics require the verified BXAGI tenant and refuse caller-selected scopes', async () => {
  const { sqlite, env } = fixture(); const calls = [];
  try {
    const injected = { resolveBxagiContext: async () => ({ userId: 'owner', subject: 'subject', accessToken: 'fixture' }), createNodeHealth: ({ context }) => ({ inspect: async () => { calls.push(context); return { nodes: [], observationStatus: 'verified' }; } }) };
    const call = (suffix = '', method = 'GET', options = injected) => handlePlatformRequest(new Request(`https://site.test/api/v2/bxagi/nodes/state${suffix}`, { method }), env, options);
    assert.equal((await call('?userId=other')).status, 400);
    assert.equal((await call('', 'POST')).status, 405);
    assert.equal((await call('', 'GET', { ...injected, resolveBxagiContext: async () => null })).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await call()).status, 200); assert.equal(calls[0].userId, 'owner');
  } finally { sqlite.close(); }
});
