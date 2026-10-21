import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';

function database() {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return { sqlite, prepare(sql) { const statement = sqlite.prepare(sql); return { bind(...args) { return {
    async first() { return statement.get(...args) ?? null; }, async all() { return { results: statement.all(...args) }; },
    async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
  }; } }; } };
}
function bucket() {
  const values = new Map();
  return { async put(key, body) { const bytes = new Uint8Array(await new Response(body).arrayBuffer()); values.set(key, bytes); return { size: bytes.length }; },
    async get(key) { const bytes = values.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes]).stream(), async arrayBuffer() { return bytes.slice().buffer; } } : null; },
    async delete(key) { values.delete(key); } };
}
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XAAAAABJRU5ErkJggg==', 'base64'));
function fixture() {
  const env = { DB: database(), BUCKET: bucket(), APP_ENCRYPTION_KEY: '34'.repeat(32), BXAGI_REQUIRED: true, APP_WORKER_SECRET: 'test-service-only' };
  const accounts = new Map([['alice', { id: 'bxagi-subject-a', token: 'AUTH_FIXTURE_TOKEN_A' }], ['bob', { id: 'bxagi-subject-b', token: 'AUTH_FIXTURE_TOKEN_B' }]]);
  const fetcher = async (url, options) => {
    const endpoint = new URL(url); assert.equal(endpoint.origin, 'https://bxagi.xinlx.com');
    if (endpoint.pathname === '/api/auth/login') { const body = JSON.parse(options.body), account = accounts.get(body.login); assert.ok(account); assert.equal(body.password, 'fixture-password'); return Response.json({ access_token: account.token }); }
    if (endpoint.pathname === '/api/auth/me') { const account = [...accounts.values()].find(account => options.headers.Authorization === `Bearer ${account.token}`); assert.ok(account); return Response.json({ id: account.id, username: account.id, email: 'same@example.test' }); }
    if (endpoint.pathname === '/api/v1/employees/mine') return Response.json({ items: [] });
    if (endpoint.pathname === '/api/v1/employees/templates') return Response.json([]);
    if (endpoint.pathname === '/api/v1/employees/pricing') return Response.json([]);
    if (endpoint.pathname === '/api/billing/free-solo-quota') return Response.json({remaining:0,quota:0});
    if (endpoint.pathname === '/api/settings') return Response.json({is_cloud_mode:true});
    assert.fail(`Unconfigured external authentication fixture: ${endpoint.pathname}`);
  };
  return { env, fetcher };
}
async function call(f, path, { method = 'GET', body, bytes, cookie, headers = {} } = {}) {
  const h = new Headers(headers); if (cookie) h.set('Cookie', cookie); if (body !== undefined) h.set('Content-Type', 'application/json');
  const response = await handlePlatformRequest(new Request(`https://app.test/api/v2${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : bytes ? { body: bytes } : {}) }), f.env, { fetcher: f.fetcher });
  return { status: response.status, data: response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer()), cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
}
async function login(f, account) {
  const result = await call(f, '/bxagi/auth/login', { method: 'POST', body: { login: account, login_type: 'username', password: 'fixture-password', termsAccepted: true } });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.ok(result.cookie); return result.cookie;
}

test('anonymous users and forged OpenAI identity headers cannot access any protected API', async () => {
  const f = fixture();
  try {
    for (const headers of [{}, { 'oai-authenticated-user-id': 'forged-owner', 'oai-authenticated-user-email': 'same@example.test', 'oai-authenticated-user-full-name': 'Fake Native Identity' }]) {
      for (const path of ['/bootstrap', '/projects', '/employees', '/connections', '/campaigns', '/audit', '/assets/known-id/content', '/creatives/known-id/content']) {
        const result = await call(f, path, { headers }); assert.equal(result.status, 401, path); assert.equal(result.data.projects, undefined); assert.equal(result.data.user, undefined);
      }
      const create = await call(f, '/projects', { method: 'POST', headers, body: { title: 'Unauthenticated write', userId: 'forged-owner' } }); assert.equal(create.status, 401);
    }
    assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM projects').get().n, 0);
    assert.equal((await call(f, '/system/health')).status, 200);
    f.env.APP_WORKER_SECRET='regular-worker-fixture-key';
    f.env.FLOW_TEST_SECRET='retired-flow-test-fixture-key-123456789';
    f.env.FLOW_TEST_OWNER='retired-test-owner';
    f.env.FLOW_TEST_EXPIRES_AT=new Date(Date.now()+60000).toISOString();
    for(const path of ['/worker/flow-test/start','/worker/flow-test/flow-'+ 'a'.repeat(32)+'/status']){
      const method=path.endsWith('/start')?'POST':'GET';
      const old=await call(f,path,{method,headers:{Authorization:`Bearer ${f.env.FLOW_TEST_SECRET}`},...(method==='POST'?{body:{}}:{})});
      assert.equal(old.status,401);assert.equal(old.data.error,'视频处理员工认证失败');
      const regular=await call(f,path,{method,headers:{Authorization:`Bearer ${f.env.APP_WORKER_SECRET}`},...(method==='POST'?{body:{}}:{})});
      assert.equal(regular.status,404);assert.equal(regular.data.error,'员工接口不存在');
    }
    assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM projects').get().n,0);
  } finally { f.env.DB.sqlite.close(); }
});

test('two actual BXAGI session subjects remain isolated despite identical email and forged native owner headers', async () => {
  const f = fixture();
  try {
    const cookieA = await login(f, 'alice'), cookieB = await login(f, 'bob');
    const a = await call(f, '/bootstrap', { cookie: cookieA }), b = await call(f, '/bootstrap', { cookie: cookieB });
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.notEqual(a.data.user.id, b.data.user.id);
    assert.equal(a.data.bxagi.profile.id, 'bxagi-subject-a'); assert.equal(b.data.bxagi.profile.id, 'bxagi-subject-b');
    const created = await call(f, '/projects', { method: 'POST', cookie: cookieA, headers: { 'oai-authenticated-user-id': b.data.user.id }, body: { title: '账户A的素材项目', userId: b.data.user.id, facts: ['纯棉面料'] } });
    assert.equal(created.status, 201); assert.equal(created.data.project.userId, a.data.user.id);
    const project = created.data.project;
    const uploaded = await call(f, `/projects/${project.id}/assets`, { method: 'POST', cookie: cookieA, bytes: png, headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length), 'X-Filename': 'actual.png' } });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data)); const asset = uploaded.data.asset;
    const own = await call(f, `/assets/${asset.id}/content`, { cookie: cookieA }); assert.equal(own.status, 200); assert.deepEqual(own.data, png);
    const attackerHeaders = { 'oai-authenticated-user-id': a.data.user.id };
    for (const path of [`/assets/${asset.id}/content`, `/projects/${project.id}/export`]) assert.equal((await call(f, path, { cookie: cookieB, headers: attackerHeaders })).status, 404, path);
    assert.equal((await call(f, `/assets/${asset.id}/content`, { headers: { ...attackerHeaders, Range: 'bytes=0-7' } })).status, 401);
    assert.equal((await call(f, `/projects/${project.id}/plan`, { method: 'POST', cookie: cookieB, headers: attackerHeaders, body: {} })).status, 404);
    const secondBootstrap = await call(f, '/bootstrap', { cookie: cookieB, headers: attackerHeaders }); assert.deepEqual(secondBootstrap.data.projects, []); assert.deepEqual(secondBootstrap.data.assets, []);
    assert.equal(await createPlatformRepository(f.env.DB).getProject(b.data.user.id, project.id), null);
    const exported = await call(f, `/projects/${project.id}/export`, { cookie: cookieA }); assert.ok(!JSON.stringify(exported.data).includes('AUTH_FIXTURE_TOKEN')); assert.ok(!JSON.stringify(exported.data).includes('tokenCiphertext'));
  } finally { f.env.DB.sqlite.close(); }
});
