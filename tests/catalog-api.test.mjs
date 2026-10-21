import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createCatalogService } from '../server/catalog-service.mjs';
import { createChangduCatalogAdapter } from '../server/adapters/changdu-catalog.mjs';

const SECRET = 'test-only-catalog-key';
const SOURCE = { label: '常读测试源', distributorId: '123456', secretKey: SECRET, autoSync: false };
const CONTRACT = {
  version: 1, path: '/novelsale/openapi/catalog/list/v1', itemsPath: 'result.items',
  fields: { externalId: 'id', title: 'title', businessMode: 'mode', episodeCount: 'episodes' },
  pageSize: 50, pageSizeParam: 'page_size',
  pagination: { type: 'cursor', parameter: 'offset', initial: '0', hasMorePath: 'has_more', nextPath: 'next_offset' }
};
const item = (externalId = 'drama-1', patch = {}) => ({ externalId, title: `测试剧 ${externalId}`, episodeCount: 20, releaseStatus: 'published', publishedAt: '2026-10-19T00:00:00.000Z', sourceUpdatedAt: '2026-10-20T00:00:00.000Z', businessMode: 'paid', sourceUrl: null, ...patch });
const page = (items, nextCursor = null) => ({ items, nextCursor, hasMore: nextCursor !== null });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, { fetchPage, configured = true, env: overrides = {}, fetcher } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const state = { failBatch: false };
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = args => ({
        bind(...values) { return bound(values); },
        async first() { const row = statement.get(...args) || null; if (state.afterFirst) await state.afterFirst(sql, args, row); return row; },
        async all() { return { results: statement.all(...args) }; },
        runSync() { const result = statement.run(...args); return { meta: { changes: Number(result.changes) }, success: true }; },
        async run() { return this.runSync(); }
      });
      return bound([]);
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.runSync());
        if (state.failBatch) { state.failBatch = false; throw new Error('Injected transactional storage failure'); }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const clock = { ms: Date.parse('2026-10-20T09:00:00.000Z') };
  const calls = [], waits = [];
  const adapter = {
    configuration: () => ({ configured, reason: configured ? '测试接口契约' : '未配置常读剧目接口契约' }),
    async fetchPage(args) { calls.push({ ...args, at: clock.ms }); return fetchPage ? fetchPage(args, calls.length) : page([item()]); }
  };
  const env = { DB, APP_ENCRYPTION_KEY: '89'.repeat(32), ...overrides };
  const repository = createPlatformRepository(DB);
  const service = () => createCatalogService({ env, repository, now: () => clock.ms, adapter, wait: async milliseconds => { waits.push(milliseconds); clock.ms += milliseconds; } });
  const httpCalls = [];
  async function call(path, { method = 'GET', body, owner = 'owner' } = {}) {
    const request = new Request(`https://platform.test/api/v2${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const response = await handlePlatformRequest(request, env, {
      resolveBxagiContext: async (_request, _env, { required }) => required && owner ? { userId: owner, nativeUserId: owner, subject: `test-${owner}`, profile: { id: owner, displayName: 'BXAGI User' } } : null,
      fetcher: async (url, options) => { httpCalls.push({ url, options }); return fetcher ? fetcher(url, options) : Response.json({ code: 200, has_more: false, result: { items: [{ id: 'http-1', title: '接口测试剧', mode: 'paid', episodes: 20 }] } }); }
    });
    return { status: response.status, data: await response.json() };
  }
  const setup = async (owner = 'owner', patch = {}) => { await service().saveSource(owner, { ...SOURCE, ...patch }); return service().start(owner); };
  async function due(owner = 'owner') {
    const status = await service().status(owner);
    clock.ms = Math.max(clock.ms + 1100, status.run?.nextRunAt ? Date.parse(status.run.nextRunAt) + 1 : 0);
  }
  return { sqlite, DB, env, clock, calls, waits, httpCalls, service, call, setup, due, state };
}

test('catalog HTTP routes require verified owner, keep secrets encrypted, and queue without verifying credentials', async t => {
  const f = fixture(t);
  assert.equal((await f.call('/catalog/status', { owner: null })).status, 401);
  const initial = await f.call('/catalog/status');
  assert.equal(initial.status, 200, JSON.stringify(initial.data));
  assert.equal(initial.data.source.configured, false);
  assert.equal(initial.data.integration.configured, true);
  assert.equal(initial.data.scheduler.running, false);
  assert.equal((await f.call('/catalog/source', { method: 'PATCH', body: { ...SOURCE, userId: 'other' } })).status, 400);
  for (const patch of [{ distributorId: 'non-numeric-id' }, { distributorId: '1'.repeat(41) }, { secretKey: 'a'.repeat(2049) }, { autoSync: 'true' }, { secretKey: '' }]) {
    assert.equal((await f.call('/catalog/source', { method: 'PATCH', body: { ...SOURCE, ...patch } })).status, 400, JSON.stringify(patch).slice(0, 100));
  }
  const saved = await f.call('/catalog/source', { method: 'PATCH', body: SOURCE });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.source.connectionStatus, 'pending');
  assert.doesNotMatch(JSON.stringify(saved.data), /test-only-catalog-key|secretsCiphertext/);
  assert.equal((await f.call('/catalog/status', { owner: 'other' })).data.source.configured, false);
  const row = f.sqlite.prepare('SELECT * FROM catalogSources WHERE userId = ?').get('owner');
  assert.ok(row);
  assert.doesNotMatch(JSON.stringify(row), /test-only-catalog-key/);
  const started = await f.call('/catalog/sync', { method: 'POST', body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(started.data.source.connectionStatus, 'pending');
  assert.equal(f.httpCalls.length, 0);
  assert.equal((await f.call('/catalog/items')).data.total, 0);
});

test('an explicitly invalid contract fails closed instead of falling back to the default', async t => {
  const f = fixture(t, { env: { CHANGDU_CATALOG_CONTRACT: '' } });
  await f.call('/catalog/source', { method: 'PATCH', body: SOURCE });
  assert.equal((await f.call('/catalog/status')).data.integration.configured, false);
  assert.equal((await f.call('/catalog/sync', { method: 'POST', body: {} })).status, 503);
  assert.equal(f.httpCalls.length, 0);
});

test('official native catalog response passes HTTP and storage with the exact i64 ID and account isolation', async t => {
  const upstreamId = '9223372036854775806';
  const f = fixture(t, { fetcher: (url, options) => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://openapi.changdupingtai.com');
    assert.equal(request.pathname, '/novelsale/openapi/content/aweme_series/list/v1/');
    assert.equal(request.searchParams.get('page_index'), '0');
    assert.equal(request.searchParams.get('page_size'), '100');
    assert.equal(options.method, 'GET');
    assert.ok(options.headers['header-sign']);
    return new Response(`{"code":200,"message":"success","total":1,"data":[{"book_id":${upstreamId},"book_name":"真实协议测试剧","episode_amount":40,"publish_status":2}]}`);
  } });
  await f.call('/catalog/source', { method: 'PATCH', body: SOURCE });
  await f.call('/catalog/sync', { method: 'POST', body: {} });
  const advanced = await f.call('/catalog/advance', { method: 'POST', body: {} });
  assert.equal(advanced.status, 200, JSON.stringify(advanced.data));
  assert.equal(advanced.data.source.connectionStatus, 'verified');
  assert.equal(advanced.data.run.status, 'completed');
  assert.equal(advanced.data.run.processed, 1);
  const listed = await f.call('/catalog/items?q=协议');
  assert.equal(listed.data.total, 1);
  assert.equal(listed.data.items[0].externalId, upstreamId);
  assert.equal(listed.data.items[0].businessMode, 'unknown');
  assert.equal(listed.data.items[0].publishedAt, null);
  assert.equal((await f.call('/catalog/items', { owner: 'other' })).data.total, 0);
  assert.equal(f.httpCalls.length, 1);
});

test('feature permission failure remains unverified and displays a safe actionable reason', async t => {
  const f = fixture(t, { fetcher: () => Response.json({ code: 413, message: SECRET }) });
  await f.call('/catalog/source', { method: 'PATCH', body: SOURCE });
  await f.call('/catalog/sync', { method: 'POST', body: {} });
  const advanced = await f.call('/catalog/advance', { method: 'POST', body: {} });
  assert.equal(advanced.data.run.status, 'failed');
  assert.equal(advanced.data.source.connectionStatus, 'error');
  assert.match(advanced.data.run.error, /未开通/);
  assert.doesNotMatch(JSON.stringify(advanced.data), /test-only-catalog-key/);
  assert.equal((await f.call('/catalog/items')).data.total, 0);
});

test('native total changes stop before importing a shifted page and continue restarts at page zero', async t => {
  let changed = true;
  const seenPages = [];
  const upstream = createChangduCatalogAdapter({ fetcher: async url => {
    const index = Number(new URL(url).searchParams.get('page_index'));
    seenPages.push(index);
    const total = changed && index === 1 ? 150 : 200;
    const start = changed && index === 1 ? 150 : index * 100;
    return Response.json({ code: 200, total, data: Array.from({ length: Math.min(100, total - index * 100) }, (_, i) => ({
      book_id: String(start + i), book_name: `原生剧 ${start + i}`,
    })) });
  } });
  const f = fixture(t, { fetchPage: args => upstream.fetchPage(args) });
  await f.setup(); await f.service().advance('owner'); await f.due();
  await f.service().advance('owner');
  const failed = await f.service().status('owner');
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.pages, 1);
  assert.match(failed.run.error, /第一页重新扫描/);
  assert.equal((await f.service().list('owner')).total, 100);
  changed = false;
  await f.service().start('owner'); await f.due(); await f.service().advance('owner');
  await f.due(); await f.service().advance('owner');
  assert.deepEqual(seenPages, [0, 1, 0, 1]);
  assert.equal((await f.service().status('owner')).run.status, 'completed');
  assert.equal((await f.service().list('owner')).total, 200);
});

test('a repeated native page cannot complete a scan and original rows and checkpoint remain intact', async t => {
  const upstream = createChangduCatalogAdapter({ fetcher: async () => Response.json({
    code: 200, total: 200, data: Array.from({ length: 100 }, (_, i) => ({ book_id: String(i), book_name: `剧 ${i}` })),
  }) });
  const f = fixture(t, { fetchPage: args => upstream.fetchPage(args) });
  await f.setup(); await f.service().advance('owner'); await f.due();
  await f.service().advance('owner');
  const failed = await f.service().status('owner');
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.pages, 1);
  assert.equal(failed.run.processed, 100);
  assert.equal((await f.service().list('owner')).total, 100);
  assert.match(failed.run.error, /重复剧目/);
});

test('native scan watermarks distinguish existing rows and repeats even with same-millisecond scans', async t => {
  let phase = 0;
  const f = fixture(t, { fetchPage: () => {
    const items = phase === 0 ? [item('old')] : phase === 1 ? [item('new')] : phase === 2 ? [item('old')] : [item('new')];
    return { ...page(items, phase > 0 && phase < 3 ? `phase-${phase}` : null), snapshotTotal: phase === 0 ? 1 : 3 };
  } });
  await f.setup(); await f.service().advance('owner');
  const firstStamp = (await f.service().status('owner')).source.lastSuccessAt;
  phase = 1;
  await f.service().start('owner');
  // Only remove the artificial quota wait to exercise clock granularity, not upstream pacing.
  f.sqlite.prepare('UPDATE catalogThrottle SET nextRequestAt=?').run(new Date(f.clock.ms).toISOString());
  await f.service().advance('owner');
  assert.ok((await f.service().status('owner')).source.lastSuccessAt > firstStamp);
  phase = 2; await f.due(); await f.service().advance('owner');
  assert.equal((await f.service().status('owner')).run.pages, 2);
  phase = 3; await f.due(); await f.service().advance('owner');
  assert.equal((await f.service().status('owner')).run.status, 'failed');
  assert.equal((await f.service().status('owner')).run.pages, 2);
});

test('configured HTTP sync acknowledges queue before networking, advance imports one page, and local queries stay local', async t => {
  const f = fixture(t, { env: { CHANGDU_CATALOG_CONTRACT: JSON.stringify(CONTRACT) } });
  assert.equal((await f.call('/catalog/source', { method: 'PATCH', body: SOURCE })).status, 200);
  const queued = await f.call('/catalog/sync', { method: 'POST', body: {} });
  assert.equal(queued.status, 202, JSON.stringify(queued.data));
  assert.equal(queued.data.run.status, 'queued');
  assert.equal(f.httpCalls.length, 0);
  const advanced = await f.call('/catalog/advance', { method: 'POST', body: {} });
  assert.equal(advanced.status, 200, JSON.stringify(advanced.data));
  assert.equal(advanced.data.run.status, 'completed');
  assert.equal(advanced.data.run.processed, 1);
  assert.equal(advanced.data.source.connectionStatus, 'verified');
  assert.equal(f.httpCalls.length, 1);
  const own = await f.call('/catalog/items?q=接口&limit=1');
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal(own.data.total, 1);
  assert.equal(own.data.items[0].externalId, 'http-1');
  assert.equal((await f.call('/catalog/items', { owner: 'other' })).data.total, 0);
  assert.equal(f.httpCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(advanced.data), /test-only-catalog-key|secretsCiphertext/);
});

test('durable cursor, paid/free identity, and metadata updates survive service recreation', async t => {
  const f = fixture(t, { fetchPage: ({ cursor }) => cursor === null ? page([item('shared'), item('shared', { businessMode: 'free' })], 'page-two') : page([item('shared', { title: '更新后的剧名', episodeCount: 21 }), item('new')]) });
  const queued = await f.setup();
  assert.equal(queued.run.status, 'queued');
  assert.equal(f.calls.length, 0);
  await f.service().advance('owner');
  let status = await f.service().status('owner');
  assert.equal(status.run.pages, 1);
  assert.equal(status.run.processed, 2);
  assert.equal((await f.service().list('owner', {})).total, 2);
  await f.due();
  await f.service().advance('owner');
  status = await f.service().status('owner');
  assert.equal(status.run.status, 'completed');
  assert.equal(status.run.processed, 4);
  assert.equal(status.run.inserted, 3);
  assert.equal(status.run.updated, 1);
  assert.deepEqual(f.calls.map(call => call.cursor), [null, 'page-two']);
  const rows = await f.service().list('owner', {});
  assert.equal(rows.total, 3);
  assert.equal(rows.items.find(row => row.externalId === 'shared' && row.businessMode === 'paid').episodeCount, 21);
  assert.equal(rows.items.filter(row => row.externalId === 'shared').length, 2);
});

test('lease claim allows only one concurrent upstream page for the same source', { timeout: 5000 }, async t => {
  const entered = gate(), release = gate();
  const f = fixture(t, { fetchPage: async () => { entered.resolve(); await release.promise; return page([item()]); } });
  await f.setup();
  const first = f.service().advance('owner');
  await entered.promise;
  const concurrent = await f.service().advance('owner');
  assert.equal(f.calls.length, 1);
  assert.ok(['running', 'waiting'].includes(concurrent.run.status));
  release.resolve();
  await first;
  assert.equal((await f.service().list('owner', {})).total, 1);
  assert.equal((await f.service().status('owner')).run.pages, 1);
});

test('pause fences an in-flight page and resume refetches its uncommitted cursor', { timeout: 5000 }, async t => {
  const entered = gate(), release = gate();
  const f = fixture(t, { fetchPage: async (_args, n) => { if (n === 1) { entered.resolve(); await release.promise; } return page([item()]); } });
  await f.setup();
  const inFlight = f.service().advance('owner');
  await entered.promise;
  assert.equal((await f.service().pause('owner')).run.status, 'paused');
  release.resolve();
  await inFlight;
  assert.equal((await f.service().list('owner', {})).total, 0);
  assert.equal((await f.service().status('owner')).run.processed, 0);
  await f.service().start('owner'); await f.due();
  await f.service().advance('owner');
  assert.equal((await f.service().list('owner', {})).total, 1);
  assert.deepEqual(f.calls.map(call => call.cursor), [null, null]);
});

test('credential changes invalidate verification and fence already dispatched writes', { timeout: 5000 }, async t => {
  const entered = gate(), release = gate();
  const f = fixture(t, { fetchPage: async () => { entered.resolve(); await release.promise; return page([item()]); } });
  await f.setup();
  const inFlight = f.service().advance('owner'); await entered.promise;
  const changed = await f.service().saveSource('owner', { ...SOURCE, secretKey: 'replacement-test-key', distributorId: '987654' });
  assert.equal(changed.source.connectionStatus, 'pending');
  release.resolve(); await inFlight;
  assert.equal((await f.service().list('owner', {})).total, 0);
  assert.notEqual((await f.service().status('owner')).source.connectionStatus, 'verified');
  assert.doesNotMatch(JSON.stringify(changed), /replacement-test-key/);
});

test('global durable request throttle covers different owners', async t => {
  const f = fixture(t);
  await f.setup('owner'); await f.setup('other');
  await Promise.all([f.service().advance('owner'), f.service().advance('other')]);
  assert.equal(f.calls.length, 1);
  const statuses = await Promise.all(['owner', 'other'].map(owner => f.service().status(owner)));
  assert.equal(statuses.filter(status => status.run.status === 'completed').length, 1);
  const waitingOwner = statuses[0].run.status === 'completed' ? 'other' : 'owner';
  await f.due(waitingOwner); await f.service().advance(waitingOwner);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].at - f.calls[0].at >= 1000);
  assert.equal((await f.service().list('owner', {})).total, 1);
  assert.equal((await f.service().list('other', {})).total, 1);
});

test('retryable upstream failure preserves checkpoint and respects backoff; auth errors stop', async t => {
  const f = fixture(t, { fetchPage: (_args, n) => {
    if (n === 1) return page([item('first')], 'next');
    if (n === 2) throw Object.assign(new Error('Rate limited'), { code: 'changdu_rate_limited', status: 429, retryable: true, retryAfterMs: 7000 });
    return page([item('last')]);
  } });
  await f.setup(); await f.service().advance('owner'); await f.due();
  await f.service().advance('owner');
  const waiting = await f.service().status('owner');
  assert.equal(waiting.run.status, 'waiting');
  assert.equal(waiting.run.pages, 1);
  assert.equal(waiting.run.processed, 1);
  assert.ok(Date.parse(waiting.run.nextRunAt) - f.clock.ms >= 7000);
  await f.service().advance('owner'); assert.equal(f.calls.length, 2);
  await f.due(); await f.service().advance('owner');
  assert.deepEqual(f.calls.map(call => call.cursor), [null, 'next', 'next']);
  assert.equal((await f.service().list('owner', {})).total, 2);

  const auth = fixture(t, { fetchPage: () => { throw Object.assign(new Error('Invalid signature'), { code: 'changdu_auth_error', status: 401, retryable: false }); } });
  await auth.setup(); await auth.service().advance('owner');
  assert.equal((await auth.service().status('owner')).run.status, 'failed');
  assert.equal((await auth.service().status('owner')).source.connectionStatus, 'error');
  await auth.due(); await auth.service().advance('owner');
  assert.equal(auth.calls.length, 1);
});

test('transaction failure rolls back all rows and cursor; retry imports the entire page once', async t => {
  const f = fixture(t, { fetchPage: () => page([item('a'), item('b')], 'next') });
  await f.setup(); f.state.failBatch = true;
  try { await f.service().advance('owner'); } catch { /* Transport response may fail; the durable checkpoint must remain unchanged. */ }
  assert.equal((await f.service().list('owner', {})).total, 0);
  assert.equal((await f.service().status('owner')).run.pages, 0);
  await f.service().start('owner'); await f.due();
  await f.service().advance('owner');
  assert.equal((await f.service().list('owner', {})).total, 2);
  assert.deepEqual(f.calls.map(call => call.cursor), [null, null]);
});

test('malformed upstream payload never verifies source or persists partially normalized rows', async t => {
  const f = fixture(t, {
    env: { CHANGDU_CATALOG_CONTRACT: JSON.stringify(CONTRACT) },
    fetcher: () => Response.json({ code: 200, has_more: false, result: { items: [{ id: 'valid', title: '有效剧名' }, { id: 'invalid' }] } })
  });
  await f.call('/catalog/source', { method: 'PATCH', body: SOURCE });
  assert.equal((await f.call('/catalog/sync', { method: 'POST', body: {} })).status, 202);
  const advanced = await f.call('/catalog/advance', { method: 'POST', body: {} });
  assert.equal(advanced.status, 200, JSON.stringify(advanced.data));
  assert.equal(advanced.data.run.status, 'failed');
  assert.notEqual(advanced.data.source.connectionStatus, 'verified');
  assert.equal((await f.call('/catalog/items')).data.total, 0);
});

test('automatic scans wait at least a minute after completion and preserve prior catalog entries', async t => {
  const f = fixture(t, { fetchPage: (_args, n) => page(n === 1 ? [item('first')] : [item('second')]) });
  await f.setup('owner', { autoSync: true }); await f.service().advance('owner');
  const completed = await f.service().status('owner');
  assert.equal(completed.run.status, 'completed');
  assert.ok(Date.parse(completed.run.nextRunAt) - f.clock.ms >= 60000);
  await f.service().tick({ limit: 1 }); assert.equal(f.calls.length, 1);
  await f.due(); await f.service().tick({ limit: 1 });
  assert.equal(f.calls.length, 2);
  assert.equal((await f.service().list('owner', {})).total, 2);
});

test('50,000 catalog rows use bounded local pagination and searchable owner-scoped queries', async t => {
  const f = fixture(t);
  await f.service().saveSource('owner', SOURCE);
  const source = f.sqlite.prepare('SELECT id FROM catalogSources WHERE userId = ?').get('owner');
  const insert = f.sqlite.prepare(`INSERT INTO catalogItems
    (id,userId,createdAt,updatedAt,sourceId,externalId,businessMode,title,episodeCount,releaseStatus,lastSeenAt,metadataHash)
    VALUES (?, 'owner', ?, ?, ?, ?, 'paid', ?, 30, 'published', ?, ?)`);
  const stamp = new Date(f.clock.ms).toISOString();
  f.sqlite.exec('BEGIN');
  for (let index = 0; index < 50_000; index++) {
    const id = `perf-${String(index).padStart(6, '0')}`;
    insert.run(id, stamp, stamp, source.id, id, `测试剧目 ${index}`, stamp, id);
  }
  f.sqlite.exec('COMMIT');
  const started = performance.now();
  const first = await f.service().list('owner', { limit: '50' });
  const firstMs = performance.now() - started;
  assert.equal(first.total, 50_000);
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  assert.ok(Number.isFinite(first.queryMs));
  const second = await f.service().list('owner', { limit: '50', cursor: first.nextCursor });
  assert.equal(second.total, 50_000);
  assert.equal(second.items.length, 50);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 100);
  const searchStart = performance.now();
  const found = await f.service().list('owner', { q: '49999', limit: '50' });
  const searchMs = performance.now() - searchStart;
  assert.equal(found.total, 1);
  assert.equal(found.items[0].externalId, 'perf-049999');
  assert.equal((await f.service().list('other', {})).total, 0);
  assert.equal(f.calls.length, 0);
  t.diagnostic(`Local SQLite, 50,000 rows: first 50 rows ${firstMs.toFixed(2)} ms; text search ${searchMs.toFixed(2)} ms. This is a local query benchmark, not live Changdu latency.`);
});


test('adapter-normalized release status up to 256 characters is accepted without contract drift', async t => {
  const f = fixture(t, { fetchPage: () => page([item('long-status', { releaseStatus: '已发布'.repeat(70) })]) });
  await f.setup(); await f.service().advance('owner');
  const status = await f.service().status('owner');
  assert.equal(status.run.status, 'completed');
  assert.equal((await f.service().list('owner', {})).items[0].releaseStatus.length, 210);
});

test('repeated A to B to A cursor cycle stops before persisting or advancing the repeated page', async t => {
  const f = fixture(t, { fetchPage: (_args, n) => page([item(`cycle-${n}`)], n === 2 ? 'B' : 'A') });
  await f.setup(); await f.service().advance('owner');
  await f.due(); await f.service().advance('owner');
  await f.due(); await f.service().advance('owner');
  const status = await f.service().status('owner');
  assert.equal(status.run.status, 'failed');
  assert.equal(status.run.pages, 2);
  assert.equal(status.run.processed, 2);
  assert.equal((await f.service().list('owner', {})).total, 2);
  assert.deepEqual(f.calls.map(call => call.cursor), [null, 'A', 'B']);
});

test('one-hour Retry-After is preserved across service recreation and globally blocks premature requests', async t => {
  const f = fixture(t, { fetchPage: (_args, n) => {
    if (n === 1) throw Object.assign(new Error('Wait for upstream quota reset'), { code: 'changdu_rate_limited', status: 429, retryable: true, retryAfterMs: 3_600_000 });
    return page([item()]);
  } });
  await f.setup(); await f.service().advance('owner');
  const waiting = await f.service().status('owner');
  assert.equal(waiting.run.status, 'waiting');
  assert.ok(Date.parse(waiting.run.nextRunAt) - f.clock.ms >= 3_600_000);
  f.clock.ms += 1_800_000;
  await f.service().advance('owner');
  await f.setup('other'); await f.service().advance('other');
  assert.equal(f.calls.length, 1);
  assert.ok(Date.parse((await f.service().status('other')).run.nextRunAt) >= Date.parse(waiting.run.nextRunAt));
  await f.due(); await f.service().advance('owner');
  assert.equal(f.calls.length, 2);
  assert.equal((await f.service().status('owner')).run.status, 'completed');
});

test('signing key whitespace is preserved exactly instead of silently changing credentials', async t => {
  const f = fixture(t);
  const key = '  exact-test-signing-key  ';
  await f.setup('owner', { secretKey: key }); await f.service().advance('owner');
  assert.equal(f.calls[0].secretKey, key);
});

test('exhausted retries still preserve the upstream-wide Retry-After for other owners', async t => {
  const f = fixture(t, { fetchPage: () => { throw Object.assign(new Error('Rate limited'), { retryable: true, retryAfterMs: 3_600_000 }); } });
  await f.setup();
  f.sqlite.prepare('UPDATE catalogSources SET retryCount=5 WHERE userId=?').run('owner');
  await f.service().advance('owner');
  assert.equal((await f.service().status('owner')).run.status, 'failed');
  f.clock.ms += 10_000;
  await f.setup('other'); await f.service().advance('other');
  assert.equal(f.calls.length, 1);
  assert.ok(Date.parse((await f.service().status('other')).run.nextRunAt) - f.clock.ms >= 3_590_000);
});


test('advance starts an overdue automatic scan, while paused sources never restart automatically', async t => {
  const f = fixture(t, { fetchPage: (_args, n) => page([item(`automatic-${n}`)]) });
  await f.setup('owner', { autoSync: true }); await f.service().advance('owner');
  const first = await f.service().status('owner');
  assert.equal(first.run.status, 'completed');
  await f.service().advance('owner'); assert.equal(f.calls.length, 1, 'completion cadence cannot be bypassed');
  await f.due();
  const second = await f.service().advance('owner');
  assert.equal(f.calls.length, 2);
  assert.equal(second.run.status, 'completed');
  assert.equal(second.run.pages, 1, 'second scan has a new per-run counter');
  assert.notEqual(second.run.startedAt, first.run.startedAt);
  assert.equal((await f.service().list('owner', {})).total, 2);
  await f.service().pause('owner');
  f.clock.ms += 120_000;
  assert.equal((await f.service().advance('owner')).run.status, 'paused');
  assert.equal((await f.service().tick({ limit: 20 })).processed, 0);
  assert.equal(f.calls.length, 2);
});

test('multi-page tick rotates across sources fairly and respects the shared request interval', async t => {
  const f = fixture(t, { fetchPage: ({ distributorId, cursor }) => {
    const index = cursor === null ? 1 : Number(cursor);
    return page([item(`${distributorId}-${index}`)], index < 12 ? String(index + 1) : null);
  } });
  await f.setup('owner', { distributorId: '100' });
  await f.setup('other', { distributorId: '200' });
  const result = await f.service().tick({ limit: 20 });
  assert.equal(result.processed, 20);
  assert.equal(f.calls.length, 20);
  assert.equal(new Set(f.calls.slice(0, 3).map(call => call.distributorId)).size, 2, 'both sources receive service before one can monopolize pagination');
  const counts = ['100', '200'].map(id => f.calls.filter(call => call.distributorId === id).length);
  assert.ok(Math.abs(counts[0] - counts[1]) <= 2, `unbalanced page scheduling: ${counts}`);
  assert.ok(counts.every(count => count > 1));
  for (let index = 1; index < f.calls.length; index++) assert.ok(f.calls[index].at - f.calls[index - 1].at >= 1000);
  assert.ok(f.waits.length > 0);
  assert.ok(f.waits.every(milliseconds => milliseconds > 0 && milliseconds <= 1000));
  const localTotals = await Promise.all(['owner', 'other'].map(async owner => (await f.service().list(owner, {})).total));
  assert.deepEqual(localTotals, counts);
});

test('long Chinese title and percent or underscore search terms are literal local substring searches', async t => {
  const longTitle = '深海契约我出海带着全家重获新生在风浪中守护亲人第二季';
  assert.ok(new TextEncoder().encode(longTitle).length > 50);
  const f = fixture(t, { fetchPage: () => page([
    item('long-title', { title: `${longTitle}全集` }),
    item('percent', { title: '成功率100%真实故事' }),
    item('underscore', { title: '测试_名称' }),
    item('other', { title: '普通剧名无需匹配' })
  ]) });
  await f.setup(); await f.service().advance('owner');
  const long = await f.service().list('owner', { q: longTitle });
  assert.equal(long.total, 1);
  assert.equal(long.items[0].externalId, 'long-title');
  for (const [query, expected] of [['%', 'percent'], ['_', 'underscore']]) {
    const found = await f.service().list('owner', { q: query });
    assert.equal(found.total, 1);
    assert.equal(found.items[0].externalId, expected);
  }
  assert.equal(f.calls.length, 1, 'searches never request the source again');
});


test('pause or disabling auto sync wins after automatic resumption has already read a completed snapshot', async t => {
  for (const action of ['pause', 'disable']) {
    const f = fixture(t);
    await f.setup('owner', { autoSync: true }); await f.service().advance('owner');
    await f.due();
    let intercepted = 0;
    f.state.afterFirst = async (sql, _args, row) => {
      if (!sql.startsWith('SELECT * FROM catalogSources') || row?.runStatus !== 'completed') return;
      // Return the originally read snapshot only after a concurrent user operation commits.
      // This catches implementations that then reread paused state and mistakenly enqueue it.
      f.state.afterFirst = null;
      intercepted++;
      if (action === 'pause') await f.service().pause('owner');
      else await f.service().saveSource('owner', { label: SOURCE.label, distributorId: SOURCE.distributorId, autoSync: false });
    };
    const result = await f.service().advance('owner');
    assert.equal(intercepted, 1, action);
    assert.equal(f.calls.length, 1, `${action} must fence automatic resumption before upstream fetch`);
    assert.equal(result.run.status, action === 'pause' ? 'paused' : 'completed');
    assert.equal(result.run.nextRunAt, null);
    if (action === 'disable') assert.equal(result.source.autoSync, false);
    assert.equal((await f.service().tick({ limit: 20 })).processed, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('enabling automatic sync after completion schedules a future scan, but never restarts a paused source', async t => {
  const f = fixture(t);
  await f.setup(); await f.service().advance('owner');
  assert.equal((await f.service().status('owner')).run.nextRunAt, null);
  const preferences = { label: SOURCE.label, distributorId: SOURCE.distributorId, autoSync: true };
  const enabled = await f.service().saveSource('owner', preferences);
  assert.equal(enabled.run.status, 'completed');
  assert.ok(Date.parse(enabled.run.nextRunAt) - f.clock.ms >= 60_000);
  await f.service().advance('owner'); assert.equal(f.calls.length, 1);
  await f.due(); await f.service().advance('owner'); assert.equal(f.calls.length, 2);
  await f.service().pause('owner');
  await f.service().saveSource('owner', { ...preferences, autoSync: false });
  const paused = await f.service().saveSource('owner', preferences);
  assert.equal(paused.source.autoSync, true);
  assert.equal(paused.run.status, 'paused');
  assert.equal(paused.run.nextRunAt, null);
  f.clock.ms += 120_000;
  await f.service().advance('owner'); await f.service().tick({ limit: 20 });
  assert.equal(f.calls.length, 2);
});
