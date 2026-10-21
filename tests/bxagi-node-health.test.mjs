import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createBxagiNodeHealth, projectBxagiNodes, mergeBxagiNodeHealth, BXAGI_NODE_HEALTH_HISTORY_LIMIT } from '../server/bxagi-node-health.mjs';

const epoch = Date.parse('2026-10-15T01:46:00.000Z');
const token = 'private-node-test-credential';
const context = { userId: 'owner-a', subject: 'subject-a', accessToken: token };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const node = (patch = {}) => ({ node_id: 'bxagi-node-owned', status: 'online', gateway_connected: true, last_heartbeat_at: new Date(epoch - 30000).toISOString(), idle_timeout_minutes: 15, ...patch });
const observation = (status, offset = 0) => ({ checkedAt: new Date(epoch + offset).toISOString(), observationStatus: 'verified', nodes: projectBxagiNodes([node({ status, last_heartbeat_at: new Date(epoch + offset - 30000).toISOString() })], { now: epoch + offset }) });

function fixture() {
  const db = new DatabaseSync(':memory:'), dir = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'));
  const repository = createPlatformRepository({ prepare(sql) { const statement = db.prepare(sql); return { bind(...args) { return { async first() { return statement.get(...args) ?? null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } }; } }; } });
  return { db, repository };
}

test('node projection excludes URLs, credentials and arbitrary fields while retaining cloud hint and heartbeat evidence', () => {
  const result = projectBxagiNodes([node({ node_url: 'wss://gateway-ws.example/private-node?key=private-url-secret', api_key: 'private-api-secret', name: token, owner: 'private-owner', traceback: 'private-error', last_heartbeat_at: '2026-10-15T09:45:30+08:00' })], { now: epoch, token });
  assert.deepEqual(result, [{ nodeId: 'bxagi-node-owned', status: 'online', gatewayConnected: true, lastHeartbeatAt: '2026-10-15T01:45:30.000Z', heartbeatAgeSeconds: 30, heartbeatState: 'fresh', idleTimeoutMinutes: 15, cloudGateway: true }]);
  for (const secret of ['example', 'private-url-secret', 'private-api-secret', token, 'private-owner', 'private-error']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(projectBxagiNodes([node({ node_url: 'https://normal.example/?redirect=gateway-ws' })], { now: epoch })[0].cloudGateway, false);
  assert.equal(projectBxagiNodes([node({ node_url: 'not-a-url-gateway-ws' })], { now: epoch })[0].cloudGateway, null);
  for (const node_id of [token, 'prefix-' + token, 'api_key-secret', 'https://example']) assert.throws(() => projectBxagiNodes([node({ node_id })], { now: epoch, token }));
});

test('invalid, future and stale heartbeat are explicit diagnostics and never rewrite reported node availability', () => {
  for (const [value, expected] of [[undefined,'unknown'], [null,'unknown'], ['secret=private','invalid'], ['2026-10-15T01:45:00','invalid'], ['2026-02-30T01:45:00Z','invalid'], ['2026-10-15T24:00:00Z','invalid'], [new Date(epoch + 120000).toISOString(),'future'], [new Date(epoch - 121000).toISOString(),'stale']]) {
    const result = projectBxagiNodes([node({ last_heartbeat_at: value, idle_timeout_minutes: 'private', gateway_connected: 'true' })], { now: epoch })[0];
    assert.equal(result.status, 'online'); assert.equal(result.heartbeatState, expected); assert.equal(result.idleTimeoutMinutes, null); assert.equal(result.gatewayConnected, null);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
  assert.throws(() => projectBxagiNodes([node(), node()], { now: epoch }));
});

test('live inspection reads only the fixed owned node endpoint and stores safe state', async () => {
  const { db, repository } = fixture();
  try {
    const calls = [], api = createBxagiNodeHealth({ repository, context, now: () => epoch, fetcher: async (url, init) => {
      calls.push(url); assert.equal(url, 'https://bxagi.xinlx.com/api/nodes'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, `Bearer ${token}`);
      return json({ nodes: [node({ node_url: 'wss://gateway-ws.example/?token=private', password: 'private-password' })] });
    } });
    const result = await api.inspect();
    assert.equal(result.liveVerified, true); assert.equal(result.persistenceStatus, 'saved'); assert.equal(result.nodes[0].stale, false); assert.equal(result.nodes[0].cloudGateway, true); assert.deepEqual(result.statusCounts, { online: 1, busy: 0, offline: 0, unknown: 0 }); assert.equal(calls.length, 1);
    const saved = await repository.getBxagiNodeHealth(context.userId, context.subject);
    assert.equal(saved.type, 'bxagi_node_health'); assert.equal(saved.details.history.length, 2); assert.equal(saved.details.lastSuccess.nodes[0].cloudGateway, true);
    for (const secret of ['gateway-ws.example', 'private-password', token]) { assert.ok(!JSON.stringify(saved).includes(secret)); assert.ok(!JSON.stringify(result).includes(secret)); }
  } finally { db.close(); }
});

test('request failure retains a marked stale snapshot and does not invent an offline node', async () => {
  const { db, repository } = fixture();
  try {
    await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('online'));
    const api = createBxagiNodeHealth({ repository, context, now: () => epoch + 60000, fetcher: async () => { throw new Error(`network failed ${token}`); } });
    const result = await api.inspect();
    assert.equal(result.liveVerified, false); assert.equal(result.observationStatus, 'unavailable'); assert.equal(result.errorCode, 'bxagi_nodes_unavailable'); assert.equal(result.nodes[0].status, 'online'); assert.equal(result.nodes[0].stale, true); assert.equal(result.lastSuccessfulAt, new Date(epoch).toISOString()); assert.equal(result.statusCounts.offline, 0);
    const saved = await repository.getBxagiNodeHealth('owner-a', 'subject-a'); assert.equal(saved.details.lastSuccess.nodes[0].status, 'online'); assert.ok(!JSON.stringify(saved).includes(token));
    const unknown = await createBxagiNodeHealth({ repository, context: { ...context, userId: 'owner-new' }, now: () => epoch, fetcher: async () => json({}, 503) }).inspect();
    assert.equal(unknown.nodeCount, 0); assert.equal(unknown.lastSuccessfulAt, null); assert.equal(unknown.liveVerified, false);
  } finally { db.close(); }
});

test('unauthorized, redirect, malformed and oversized responses stay unavailable with bounded safe codes', async () => {
  for (const [fetcher, code] of [
    [async () => json({ token }, 401), 'bxagi_nodes_unauthorized'],
    [async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }), 'bxagi_nodes_redirect_refused'],
    [async () => json({ nodes: 'private-data' }), 'bxagi_nodes_invalid_response'],
    [async () => new Response('{}', { headers: { 'Content-Length': '1048577' } }), 'bxagi_nodes_invalid_response'],
    [async () => json({ nodes: [node({ node_id: token })] }), 'bxagi_nodes_invalid_response'],
  ]) {
    const report = await createBxagiNodeHealth({ context, fetcher, now: () => epoch }).inspect();
    assert.equal(report.errorCode, code); assert.equal(report.liveVerified, false); assert.deepEqual(report.nodes, []); assert.ok(!JSON.stringify(report).includes(token));
  }
});

test('timeout aborts a nonresponding upstream and a diagnostics storage failure does not erase a live result', async () => {
  let signal;
  const report = await createBxagiNodeHealth({ context, now: () => epoch, timeoutMs: 100, fetcher: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } }).inspect();
  assert.equal(report.errorCode, 'bxagi_nodes_timeout'); assert.equal(signal.aborted, true);
  const live = await createBxagiNodeHealth({ context, now: () => epoch, repository: { async recordBxagiNodeHealth() { throw new Error('db'); } }, fetcher: async () => json({ nodes: [node()] }) }).inspect();
  assert.equal(live.liveVerified, true); assert.equal(live.persistenceStatus, 'unavailable'); assert.equal(live.nodes[0].status, 'online');
});

test('journal scopes both owner and subject and ignores cross-scope rows from a broken repository', async () => {
  const { db, repository } = fixture();
  try {
    const a = await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('online'));
    const b = await repository.recordBxagiNodeHealth('owner-b', 'subject-a', observation('offline'));
    const c = await repository.recordBxagiNodeHealth('owner-a', 'subject-b', observation('busy'));
    assert.equal(new Set([a.id, b.id, c.id]).size, 3); assert.equal(await repository.getBxagiNodeHealth('owner-c', 'subject-a'), null);
    assert.equal((await repository.getBxagiNodeHealth('owner-a', 'subject-a')).details.lastSuccess.nodes[0].status, 'online');
    const report = await createBxagiNodeHealth({ context, now: () => epoch + 1000, repository: { async getBxagiNodeHealth() { return b; } }, fetcher: async () => json({}, 503) }).inspect();
    assert.equal(report.nodeCount, 0); assert.equal(report.lastSuccessfulAt, null);
  } finally { db.close(); }
});

test('same-state heartbeats deduplicate history while actual changes, disappearance and recovery are auditable', async () => {
  const { db, repository } = fixture();
  try {
    await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('online'));
    let saved = await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('online', 30000));
    assert.equal(saved.details.history.length, 2); assert.equal(saved.details.lastSuccess.nodes[0].lastHeartbeatAt, new Date(epoch).toISOString());
    saved = await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('offline', 60000)); assert.equal(saved.details.history.at(-1).from.status, 'online'); assert.equal(saved.details.history.at(-1).to.status, 'offline');
    saved = await repository.recordBxagiNodeHealth('owner-a', 'subject-a', { checkedAt: new Date(epoch + 90000).toISOString(), observationStatus: 'verified', nodes: [] });
    assert.equal(saved.details.history.at(-1).to, null); assert.equal(saved.details.lastSuccess.nodes.length, 0);
    saved = await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('online', 120000)); assert.equal(saved.details.history.at(-1).from, null); assert.equal(saved.details.history.at(-1).to.status, 'online');
    const stale = await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('offline', 30000)); assert.equal(stale.details.lastSuccess.nodes[0].status, 'online');
  } finally { db.close(); }
});

test('parallel observation inserts share a journal and bounded history never grows beyond the cap', async () => {
  const { db, repository } = fixture();
  try {
    await Promise.all([repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('online')), repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation('offline', 1000))]);
    assert.equal((await repository.listJobs('owner-a')).length, 1);
    let saved;
    for (let i = 2; i < BXAGI_NODE_HEALTH_HISTORY_LIMIT + 10; i++) saved = await repository.recordBxagiNodeHealth('owner-a', 'subject-a', observation(i % 2 ? 'online' : 'offline', i * 1000));
    assert.equal(saved.details.history.length, BXAGI_NODE_HEALTH_HISTORY_LIMIT); assert.equal(saved.details.history.at(-1).to.status, 'online');
    assert.equal((await repository.listJobs('owner-a')).length, 1);
  } finally { db.close(); }
});

test('persistence projection strips supplied extra fields and unsupported error text', () => {
  const safe = mergeBxagiNodeHealth(null, { ...observation('online'), token, nodes: [{ ...observation('online').nodes[0], url: 'https://secret.example', credential: token }] }, 'subject-a');
  assert.ok(!JSON.stringify(safe).includes(token)); assert.ok(!JSON.stringify(safe).includes('secret.example'));
  const failed = mergeBxagiNodeHealth(safe, { checkedAt: new Date(epoch + 1000).toISOString(), observationStatus: 'unavailable', errorCode: token, error: token, nodes: [{ token }] }, 'subject-a');
  assert.equal(failed.observation.errorCode, 'bxagi_nodes_unavailable'); assert.ok(!JSON.stringify(failed).includes(token)); assert.equal(failed.lastSuccess.nodes[0].status, 'online');
});
