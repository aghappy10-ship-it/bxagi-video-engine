import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChangduCatalogAdapter } from '../server/adapters/changdu-catalog.mjs';

// This path and all payloads are fixtures. No test contacts Changdu or asserts a live endpoint exists.
const CONTRACT = {
  version: 1,
  path: '/novelsale/openapi/catalog_fixture/list/v1/',
  query: { kind: '漫剧', include: 1 },
  pageSize: 50,
  pageSizeParam: 'page_size',
  itemsPath: 'result.items',
  pagination: { type: 'cursor', parameter: 'offset', initial: '0', hasMorePath: 'has_more', nextPath: 'next_offset' },
  fields: {
    externalId: 'id', title: 'name', episodeCount: 'episodes', releaseStatus: 'state',
    publishedAt: 'published', sourceUpdatedAt: 'updated', businessMode: 'mode', sourceUrl: 'link',
  },
};
const CREDS = { distributorId: '100001', secretKey: 'fixture-private-signing-key' };
const NOW = 1792487342000;
const ROW = { id: '18795588377385991234', name: '测试剧目', episodes: 161, state: 'published', mode: 'paid', published: '2026-10-20T10:00:00+08:00', updated: '2026-10-20T02:10:00Z', link: 'https://media.example.test/detail/123' };
const payload = (overrides = {}) => ({ code: 200, result: { items: [ROW] }, has_more: false, next_offset: 50, ...overrides });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const adapter = (fetcher, contract = CONTRACT) => createChangduCatalogAdapter({ env: { CHANGDU_CATALOG_CONTRACT: JSON.stringify(contract) }, fetcher, now: () => NOW });

test('explicit invalid protocols fail closed without any upstream request or leaked configuration', async () => {
  let calls = 0;
  for (const raw of ['', null, '{"path":"private-invalid-path"', 'null', '[]']) {
    const client = createChangduCatalogAdapter({ env: { CHANGDU_CATALOG_CONTRACT: raw }, fetcher: () => { calls++; } });
    assert.equal(client.configuration().configured, false);
    assert.ok(!client.configuration().reason.includes('private-invalid-path'));
    await assert.rejects(client.fetchPage(CREDS), error => error.status === 503 && error.retryable === false);
  }
  assert.equal(calls, 0);
});

test('GET signs sorted unencoded values and sends no secret, browser token, or mutation', async () => {
  let calls = 0;
  const client = adapter(async (urlText, options) => {
    calls++;
    const url = new URL(urlText);
    assert.equal(url.origin, 'https://openapi.changdupingtai.com');
    assert.equal(url.pathname, CONTRACT.path);
    assert.deepEqual([...url.searchParams.keys()], ['distributor_id', 'include', 'kind', 'offset', 'page_size']);
    assert.equal(url.searchParams.get('kind'), '漫剧');
    const expected = createHash('md5').update('100001' + CREDS.secretKey + '1792487342' + '100001|1|漫剧|0|50|').digest('hex');
    assert.equal(options.headers['header-sign'], expected);
    assert.equal(options.headers['header-ts'], '1792487342');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body, undefined);
    assert.ok(!urlText.includes(CREDS.secretKey));
    assert.ok(!JSON.stringify(options.headers).includes(CREDS.secretKey));
    return json(payload());
  });
  assert.equal(client.configuration().configured, true);
  const page = await client.fetchPage(CREDS);
  assert.equal(calls, 1);
  assert.deepEqual(page, {
    items: [{ externalId: ROW.id, title: ROW.name, episodeCount: 161, releaseStatus: 'published', businessMode: 'paid', publishedAt: '2026-10-20T02:00:00.000Z', sourceUpdatedAt: '2026-10-20T02:10:00.000Z', sourceUrl: ROW.link }],
    hasMore: false, nextCursor: null,
  });
});

test('explicit cursor pagination uses upstream token and never silently infers another page', async () => {
  const cursors = [];
  const client = adapter(async url => {
    cursors.push(new URL(url).searchParams.get('offset'));
    return json(payload({ has_more: cursors.length === 1, next_offset: 'next/page+token=' }));
  });
  const first = await client.fetchPage(CREDS);
  assert.equal(first.nextCursor, 'next/page+token=');
  assert.equal(first.hasMore, true);
  const last = await client.fetchPage({ ...CREDS, cursor: first.nextCursor });
  assert.equal(last.nextCursor, null);
  assert.deepEqual(cursors, ['0', 'next/page+token=']);
});

test('explicit page pagination uses configured starting page and advances only on hasMore true', async () => {
  const contract = { ...CONTRACT, pagination: { type: 'page', parameter: 'page_index', initial: 0, hasMorePath: 'has_more' } };
  let page;
  const client = adapter(async url => { page = new URL(url).searchParams.get('page_index'); return json(payload({ has_more: true })); }, contract);
  assert.equal((await client.fetchPage(CREDS)).nextCursor, '1');
  assert.equal(page, '0');
  assert.equal((await client.fetchPage({ ...CREDS, cursor: '9' })).nextCursor, '10');
  assert.equal(page, '9');
  for (const cursor of ['1.5', '01', '-1', '9007199254740992', 'undefined']) {
    await assert.rejects(client.fetchPage({ ...CREDS, cursor }), error => error.code === 'changdu_cursor_invalid');
  }
});

test('ambiguous pagination and empty continuation pages are rejected', async () => {
  for (const body of [
    payload({ has_more: 'true' }), payload({ has_more: undefined }),
    payload({ has_more: true, next_offset: '0' }), payload({ has_more: true, next_offset: undefined }),
    payload({ has_more: true, next_offset: 9007199254740992 }),
    payload({ has_more: true, result: { items: [] } }),
  ]) {
    await assert.rejects(adapter(async () => json(body)).fetchPage(CREDS), error => error.code === 'changdu_response_invalid' && !error.retryable);
  }
});

test('URL guard rejects alternate origins, traversal, query, fragment, escapes and mutation action paths', async () => {
  let calls = 0;
  for (const path of [
    'https://evil.example/novelsale/openapi/list', '//evil.example/list', '/novelsale/openapi/../list',
    '/novelsale/openapi/%2e%2e/list', '/novelsale/openapi/list?token=a', '/novelsale/openapi/list#test',
    '/novelsale/openapi/list\\evil', '/novelsale/openapi/promotion/create/v1', '/novelsale/openapi/update_list/v1',
    '/novelsale/openapi/deleteLink/v1', '/novelsale/openapi/submit/v1', '/novelsale/openapi/upload/v1',
  ]) {
    const client = adapter(async () => { calls++; return json(payload()); }, { ...CONTRACT, path });
    assert.equal(client.configuration().configured, false, path);
    await assert.rejects(client.fetchPage(CREDS), error => error.status === 503);
  }
  assert.equal(calls, 0);
});

test('strict schema rejects credential query overrides, unexpected properties and unsupported page sizes', () => {
  for (const change of [
    { query: { secret_key: 'must-not-be-sent' } }, { query: { distributor_id: 'other' } },
    { query: { page_size: 100 } }, { query: { flag: true } },
    { query: { number: Number.MAX_SAFE_INTEGER + 1 } }, { method: 'POST' },
    { fields: { ...CONTRACT.fields, title: '__proto__.name' } },
    { pageSize: 101 }, { pageSize: 0 }, { pageSize: 1.5 },
    { timeoutMs: 8001 }, { timeoutMs: 0 }, { itemsPath: 'result..items' },
    { pagination: { ...CONTRACT.pagination, parameter: 'page_size' } },
  ]) assert.equal(adapter(() => {}, { ...CONTRACT, ...change }).configuration().configured, false);
});

test('invalid numeric IDs fail closed while string IDs keep leading zeros and all digits', async () => {
  for (const id of [-1, 1.5, 1e30, null, '', {}]) {
    await assert.rejects(adapter(async () => json(payload({ result: { items: [{ ...ROW, id }] } }))).fetchPage(CREDS), error => error.code === 'changdu_response_invalid');
  }
  for (const id of ['000123', '18795588377385991234', 123]) {
    const page = await adapter(async () => json(payload({ result: { items: [{ ...ROW, id }] } }))).fetchPage(CREDS);
    assert.equal(page.items[0].externalId, String(id));
  }
});

test('normalization does not infer authorization, business type, timestamps or downloadable media', async () => {
  for (const link of ['javascript:alert(1)', 'http://example.test/a', 'https://user:password@example.test/a', 'not a URL']) {
    const page = await adapter(async () => json(payload({ result: { items: [{ ...ROW, mode: 1, state: 2, episodes: '161', published: 1792487342, updated: '2026-10-20', link }] } }))).fetchPage(CREDS);
    assert.equal(page.items[0].sourceUrl, null);
    assert.equal(page.items[0].businessMode, 'unknown');
    assert.equal(page.items[0].releaseStatus, '2');
    assert.equal(page.items[0].episodeCount, null);
    assert.equal(page.items[0].publishedAt, null);
    assert.equal(page.items[0].sourceUpdatedAt, null);
  }
});

test('application codes separate permanent auth/config failures from retryable throttling and outages', async () => {
  for (const [code, expected, retryable] of [[410, 'changdu_auth_failed', false], [411, 'changdu_auth_failed', false], [412, 'changdu_auth_failed', false], [413, 'changdu_api_not_enabled', false], [500, 'changdu_rate_limited', true], [501, 'changdu_upstream_error', true], ['200', 'changdu_response_invalid', false]]) {
    let calls = 0;
    await assert.rejects(adapter(async () => { calls++; return json(payload({ code, message: CREDS.secretKey })); }).fetchPage(CREDS), error => {
      assert.equal(error.code, expected);
      assert.equal(error.retryable, retryable);
      assert.ok(!error.message.includes(CREDS.secretKey));
      assert.ok(!JSON.stringify(error).includes(CREDS.secretKey));
      return true;
    });
    assert.equal(calls, 1, 'adapter must not retry internally');
  }
});

test('HTTP errors are sanitized and expose bounded retry-after information', async () => {
  for (const [status, code, retryable] of [[401, 'changdu_auth_failed', false], [403, 'changdu_auth_failed', false], [429, 'changdu_rate_limited', true], [503, 'changdu_http_error', true], [404, 'changdu_http_error', false]]) {
    await assert.rejects(adapter(async () => new Response(CREDS.secretKey, { status, headers: { 'retry-after': '99999999' } })).fetchPage(CREDS), error => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.ok(!error.message.includes(CREDS.secretKey));
      if (status === 429) assert.equal(error.retryAfterMs, 3600000);
      return true;
    });
  }
});

test('redirects are refused without follow-up requests and response bodies are cancelled', async () => {
  for (const status of [300, 301, 302, 303, 307, 308]) {
    let calls = 0, cancelled = false;
    await assert.rejects(adapter(async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: 'https://other.example.test/' } });
    }).fetchPage(CREDS), error => error.code === 'changdu_redirect_refused');
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
  const response = json(payload());
  Object.defineProperty(response, 'url', { value: 'https://other.example.test/' });
  await assert.rejects(adapter(async () => response).fetchPage(CREDS), error => error.code === 'changdu_redirect_refused');
});

test('declared and streamed oversized responses are cancelled before JSON parsing', async () => {
  let declaredCancelled = false, streamCancelled = false;
  await assert.rejects(adapter(async () => new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })).fetchPage(CREDS), error => error.code === 'changdu_response_too_large');
  await assert.rejects(adapter(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { streamCancelled = true; },
  }))).fetchPage(CREDS), error => error.code === 'changdu_response_too_large');
  assert.equal(declaredCancelled, true);
  assert.equal(streamCancelled, true);
});

test('timeouts bound both an unresponsive fetcher and a stalled response stream', async () => {
  let aborted = false;
  await assert.rejects(adapter(async (_url, options) => {
    options.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  }, { ...CONTRACT, timeoutMs: 15 }).fetchPage(CREDS), error => error.code === 'changdu_timeout' && error.status === 504 && error.retryable);
  assert.equal(aborted, true);
  let cancelled = false;
  await assert.rejects(adapter(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), { ...CONTRACT, timeoutMs: 15 }).fetchPage(CREDS), error => error.code === 'changdu_timeout');
  assert.equal(cancelled, true);
});

test('network errors and malformed JSON never expose upstream content or request details', async () => {
  await assert.rejects(adapter(async () => { throw new Error('signature=injected-private-signature&secret=' + CREDS.secretKey); }).fetchPage(CREDS), error => error.code === 'changdu_network_error' && !error.message.includes('signature=') && !error.message.includes(CREDS.secretKey));
  await assert.rejects(adapter(async () => new Response(CREDS.secretKey)).fetchPage(CREDS), error => error.code === 'changdu_response_invalid' && !error.message.includes(CREDS.secretKey));
});

test('credentials and invalid cursors are validated before any network request', async () => {
  let calls = 0;
  const client = adapter(async () => { calls++; return json(payload()); });
  for (const credentials of [{}, { ...CREDS, distributorId: 100001 }, { ...CREDS, distributorId: '100?sign=x' }, { ...CREDS, secretKey: '' }]) {
    await assert.rejects(client.fetchPage(credentials), error => error.code === 'changdu_credentials_missing');
  }
  for (const cursor of [undefined, {}, 1, '', 'line\nbreak']) {
    if (cursor === undefined) continue; // omitted cursor intentionally starts a scan
    await assert.rejects(client.fetchPage({ ...CREDS, cursor }), error => error.code === 'changdu_cursor_invalid');
  }
  assert.equal(calls, 0);
});

const nativeRow = (index = 0) => ({
  book_id: String(100000 + index), book_name: `端原生剧目 ${index}`, episode_amount: 24, publish_status: 2,
  publish_time: '2026-10-20 12:00:00', create_time: '1792487342', permission_status: 1,
  single_price: '0', delivery_status: true, thumb_url: 'https://media.example.test/cover.png',
});
const nativeRows = count => Array.from({ length: count }, (_, index) => nativeRow(index));
const nativeClient = fetcher => createChangduCatalogAdapter({ fetcher, now: () => NOW });

test('default native profile signs the documented GET and follows total across full and final pages', async () => {
  const calls = [];
  const client = nativeClient(async (urlText, options) => {
    const url = new URL(urlText);
    calls.push(url.searchParams.get('page_index'));
    assert.equal(url.origin, 'https://openapi.changdupingtai.com');
    assert.equal(url.pathname, '/novelsale/openapi/content/aweme_series/list/v1/');
    assert.deepEqual([...url.searchParams.entries()], [
      ['distributor_id', CREDS.distributorId], ['page_index', String(calls.length - 1)],
      ['page_size', '100'], ['sort_field', '8'], ['sort_type', '1'],
    ]);
    const expected = createHash('md5').update(CREDS.distributorId + CREDS.secretKey + '1792487342' +
      `${CREDS.distributorId}|${calls.length - 1}|100|8|1|`).digest('hex');
    assert.equal(options.headers['header-sign'], expected);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.body, undefined);
    return json({ code: 200, total: 203, data: nativeRows(calls.length === 3 ? 3 : 100) });
  });
  assert.equal(client.configuration().configured, true);
  assert.match(client.configuration().reason, /尚需验证账户权限和连接/);
  const first = await client.fetchPage(CREDS);
  assert.equal(first.nextCursor, 'changdu-total-v1:1:203'); assert.equal(first.hasMore, true); assert.equal(first.items.length, 100);
  assert.equal(first.snapshotTotal, 203);
  const second = await client.fetchPage({ ...CREDS, cursor: first.nextCursor });
  assert.equal(second.nextCursor, 'changdu-total-v1:2:203'); assert.equal(second.hasMore, true);
  const last = await client.fetchPage({ ...CREDS, cursor: second.nextCursor });
  assert.equal(last.nextCursor, null); assert.equal(last.hasMore, false); assert.equal(last.items.length, 3);
  assert.equal(last.snapshotTotal, 203);
  assert.deepEqual(calls, ['0', '1', '2']);
  assert.deepEqual(first.items[0], {
    externalId: '100000', title: '端原生剧目 0', episodeCount: 24, releaseStatus: '2',
    businessMode: 'unknown', publishedAt: null, sourceUpdatedAt: null, sourceUrl: null,
  });
});

test('total pagination accepts genuine empty catalogs and exact full final pages without probing beyond total', async () => {
  for (const [total, cursor, count] of [[0, null, 0], [100, null, 100], [200, '1', 100], [1000000, '9999', 100]]) {
    const page = await nativeClient(async () => json({ code: 200, total, data: nativeRows(count) })).fetchPage({ ...CREDS, cursor });
    assert.equal(page.hasMore, false); assert.equal(page.nextCursor, null); assert.equal(page.items.length, count);
  }
});

test('total pagination rejects short, empty, oversized, missing and contradictory pages without declaring completion', async () => {
  const cases = [
    { total: 101, data: nativeRows(99) }, { total: 101, data: [] }, { total: 1, data: [] },
    { total: 0, data: nativeRows(1) }, { total: 99, data: nativeRows(100) },
    { total: 101, data: nativeRows(101) }, { total: '1', data: nativeRows(1) },
    { total: -1, data: [] }, { total: 1.5, data: nativeRows(1) }, { data: [] },
    { total: 1, data: null }, { total: 1000001, data: nativeRows(100) },
    { total: 9007199254740992, data: nativeRows(100) },
  ];
  for (const body of cases) {
    await assert.rejects(nativeClient(async () => json({ code: 200, ...body })).fetchPage(CREDS),
      error => error.code === 'changdu_response_invalid' && !error.retryable);
  }
  for (const [total, data] of [[100, []], [0, []], [101, []], [101, nativeRows(2)]]) {
    await assert.rejects(nativeClient(async () => json({ code: 200, total, data })).fetchPage({ ...CREDS, cursor: '1' }),
      error => error.code === 'changdu_response_invalid');
  }
  let calls = 0;
  const client = nativeClient(async () => { calls++; return json({ code: 200, total: 0, data: [] }); });
  for (const cursor of ['10000', '10001', '-1', '01', '1.5', '9007199254740992']) {
    await assert.rejects(client.fetchPage({ ...CREDS, cursor }), error => error.code === 'changdu_cursor_invalid');
  }
  assert.equal(calls, 0);
});

test('raw numeric i64 IDs are preserved exactly without reviver context and textual lookalikes stay textual', async () => {
  const text = '{"code":200,"total":3,"data":[' +
    '{"book_id":9223372036854775807,"book_name":"ID 9223372036854775807, \\"book_id\\":1"},' +
    '{"book_id":9007199254740993,"book_name":"unicode \\u4e2d\\u6587"},' +
    '{"book_id":"0009007199254740993","book_name":"quoted ID"}]}';
  const page = await nativeClient(async () => new Response(text)).fetchPage(CREDS);
  assert.deepEqual(page.items.map(item => item.externalId), ['9223372036854775807', '9007199254740993', '0009007199254740993']);
  assert.equal(page.items[0].title, 'ID 9223372036854775807, "book_id":1');
  assert.equal(page.items[1].title, 'unicode 中文');
  const customText = '{"code":200,"has_more":false,"result":{"items":[{"id":9223372036854775807,"name":"custom"}]}}';
  assert.equal((await adapter(async () => new Response(customText)).fetchPage(CREDS)).items[0].externalId, '9223372036854775807');
});

test('portable parser rejects malformed JSON, ambiguous keys and unbounded nesting with sanitized errors', async () => {
  for (const text of [
    '{"code":200,"total":1,"data":[{"book_id":01,"book_name":"bad"}]}',
    '{"code":200,"total":1,"data":[{"book_id":-9223372036854775808,"book_name":"bad"}]}',
    '{"code":200,"total":1,"data":[{"book_id":9223372036854775807.0,"book_name":"bad"}]}',
    '{"code":200,"total":1,"data":[{"book_id":1,"book_name":"bad",}]}',
    '{"code":200,"code":413,"total":0,"data":[]}',
    '{"code":200,"total":0,"data":[]} private-secret',
    '['.repeat(70) + '0' + ']'.repeat(70),
  ]) {
    await assert.rejects(nativeClient(async () => new Response(text)).fetchPage(CREDS), error => {
      assert.equal(error.code, 'changdu_response_invalid');
      assert.ok(!error.message.includes(text)); return true;
    });
  }
});

test('total contracts remain explicit and reject ambiguous pagination schemas', async () => {
  const pagination = { type: 'page', parameter: 'page_index', initial: 1, totalPath: 'result.total', maxPage: 4 };
  const client = adapter(async () => json({ code: 200, result: { total: 51, items: [ROW] } }), { ...CONTRACT, pagination });
  const last = await client.fetchPage({ ...CREDS, cursor: '2' });
  assert.equal(last.hasMore, false);
  for (const change of [
    { ...pagination, hasMorePath: 'has_more' }, { ...pagination, maxPage: 0 },
    { ...pagination, maxPage: 1.5 }, { ...pagination, totalPath: '' },
    { ...CONTRACT.pagination, totalPath: 'total' }, { ...CONTRACT.pagination, maxPage: 10000 },
  ]) assert.equal(adapter(() => {}, { ...CONTRACT, pagination: change }).configuration().configured, false);
});

test('official application code 413 clearly identifies missing endpoint permission without leaking upstream text', async () => {
  await assert.rejects(nativeClient(async () => json({ code: 413, message: CREDS.secretKey })).fetchPage(CREDS), error => {
    assert.equal(error.code, 'changdu_api_not_enabled'); assert.equal(error.status, 403); assert.equal(error.retryable, false);
    assert.match(error.message, /尚未开通此接口权限/); assert.ok(!error.message.includes(CREDS.secretKey)); return true;
  });
});

test('total snapshot survives adapter recreation and rejects shrinking or growing totals before completion', async () => {
  const first = await nativeClient(async () => json({ code: 200, total: 203, data: nativeRows(100) })).fetchPage(CREDS);
  assert.equal(first.nextCursor, 'changdu-total-v1:1:203');
  for (const [total, count] of [[200, 100], [101, 1], [99, 0], [0, 0], [300, 100]]) {
    let calls = 0;
    const restarted = nativeClient(async url => {
      calls++;
      assert.equal(new URL(url).searchParams.get('page_index'), '1');
      return json({ code: 200, total, data: nativeRows(count) });
    });
    await assert.rejects(restarted.fetchPage({ ...CREDS, cursor: first.nextCursor }), error => {
      assert.equal(error.code, 'changdu_total_changed');
      assert.equal(error.status, 409); assert.equal(error.retryable, false);
      assert.match(error.message, /重新开始全量同步/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('legacy numeric total cursors establish a snapshot for subsequent pages and malformed envelopes never reach upstream', async () => {
  const page = await nativeClient(async url => {
    assert.equal(new URL(url).searchParams.get('page_index'), '1');
    return json({ code: 200, total: 203, data: nativeRows(100) });
  }).fetchPage({ ...CREDS, cursor: '1' });
  assert.equal(page.nextCursor, 'changdu-total-v1:2:203');
  let calls = 0;
  const client = nativeClient(async () => { calls++; return json({ code: 200, total: 0, data: [] }); });
  for (const cursor of [
    'changdu-total-v1:1', 'changdu-total-v1:01:203', 'changdu-total-v1:1:0203',
    'changdu-total-v1:1:0', 'changdu-total-v1:0:203', 'changdu-total-v1:1:100',
    'changdu-total-v1:1:9007199254740992', 'changdu-total-v1:1:1000001',
    'changdu-total-v1:10000:1000000', 'changdu-total-v1:1:203:extra',
  ]) {
    await assert.rejects(client.fetchPage({ ...CREDS, cursor }), error => error.code === 'changdu_cursor_invalid');
  }
  assert.equal(calls, 0);
});

test('a page containing duplicate normalized external IDs is rejected instead of silently counting duplicates', async () => {
  for (const rows of [
    [nativeRow(), nativeRow()],
    [{ ...nativeRow(), book_id: 123 }, { ...nativeRow(1), book_id: '123' }],
  ]) {
    await assert.rejects(nativeClient(async () => json({ code: 200, total: 2, data: rows })).fetchPage(CREDS),
      error => error.code === 'changdu_response_invalid');
  }
  await assert.rejects(adapter(async () => json(payload({ result: { items: [ROW, ROW] } }))).fetchPage(CREDS),
    error => error.code === 'changdu_response_invalid');
});
