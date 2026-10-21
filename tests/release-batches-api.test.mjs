import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const DB = { prepare(sql) { const statement = sqlite.prepare(sql); return { bind(...args) { return { async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { const result = statement.run(...args); return { meta: { changes: Number(result.changes) } }; } }; } }; } };
  const env = { DB, APP_ENCRYPTION_KEY: '89'.repeat(32) }, calls = [];
  async function call(path, { method = 'GET', body, owner = 'owner' } = {}) {
    const request = new Request(`https://platform.test/api/v2${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const response = await handlePlatformRequest(request, env, { resolveBxagiContext: async (_request, _env, { required }) => required && owner ? { userId: owner, nativeUserId: owner, subject: `test-${owner}`, profile: { id: owner, displayName: 'BXAGI User' } } : null, fetcher: async (url, options) => { calls.push({ url, options }); return Response.json({ code: 0, data: { list: [] } }); } });
    return { status: response.status, data: await response.json() };
  }
  const create = async body => {
    const response = await call('/release-batches', { method: 'POST', body: { title: '十月剧目准备', names: ['测试剧甲'], targetCount: 2, promotionMode: 'both', ...body } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.batch;
  };
  const patch = (batch, body, options = {}) => call(`/release-batches/${batch.id}/items/${batch.items[0].id}`, { method: 'PATCH', body: { revision: batch.revision, ...body }, ...options });
  return { call, create, patch, calls, sqlite, repository: createPlatformRepository(DB) };
}
const paidLink = { id: 'paid-101', url: 'aweme://playlet?promotion_id=101&mode=paid&path=%2Ftest+value', startEpisode: 9 };
const freeLink = { id: 'free-102', url: 'aweme://playlet?promotion_id=102&mode=free', startEpisode: 2 };

test('release batches persist 100×30 planning targets without dispatch, separate from production jobs', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  assert.equal((await f.call('/release-batches', { owner: null })).status, 401);
  assert.equal((await f.call('/release-batches', { owner: null, method: 'POST', body: {} })).status, 401);
  const batch = await f.create({ names: Array.from({ length: 100 }, (_, i) => `剧目 ${i + 1}`), targetCount: 30 });
  assert.deepEqual(batch.summary, { total: 100, targetCount: 3000, ready: 0, blocked: 100 });
  assert.equal(batch.revision, 1);
  assert.equal(batch.items[0].verifiedAt, null);
  assert.equal(batch.items[0].readiness.sourceCount, 0);
  assert.equal((await f.call('/release-batches')).data.batches[0].id, batch.id);
  assert.equal((await f.call('/release-batches', { owner: 'other' })).data.batches.length, 0);
  assert.equal((await f.patch(batch, { priority: 'high' }, { owner: 'other' })).status, 404);
  assert.equal((await f.repository.listJobs('owner')).length, 0, 'planning rows do not displace actual execution jobs');
  const row = f.sqlite.prepare('SELECT status,employeeId,projectId FROM jobs WHERE id = ?').get(batch.id);
  assert.equal(row.status, 'draft'); assert.equal(row.employeeId, ''); assert.equal(row.projectId, '');
  assert.equal(f.calls.length, 0);
});

test('import trims and deduplicates names, rejects malformed or excessive targets and forged state', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const batch = await f.create({ names: [' 同一部剧 ', '同一部剧', '另一部剧'] });
  assert.equal(batch.summary.total, 2);
  const invalid = [{ names: [] }, { names: Array(101).fill('剧名') }, { names: [''] }, { names: ['剧名\n第二行'] }, { names: [null] }, { targetCount: 0 }, { targetCount: 31 }, { targetCount: 1.5 }, { promotionMode: 'automatic' }, { userId: 'other' }, { secret_key: 'never-store-this' }];
  for (const patch of invalid) {
    const result = await f.call('/release-batches', { method: 'POST', body: { title: '批次', names: ['剧名'], targetCount: 2, promotionMode: 'both', ...patch } });
    assert.equal(result.status, 400, JSON.stringify(patch));
  }
  for (const forged of [{ readiness: { ready: true } }, { verifiedAt: new Date().toISOString() }, { sourceCount: 5 }, { revision: 0 }, { dailyBudget: 0.001 }, { dailyBudget: 0.000000001 }, { failureStage: 'hidden' }]) assert.equal((await f.patch(batch, forged)).status, 400, JSON.stringify(forged));
  assert.equal((await f.call('/release-batches')).data.batches[0].revision, 1);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE details LIKE '%never-store-this%'").get().count, 0);
});

test('paid and free links are separately recorded and URLs preserved; unsupported schemes and malformed links fail', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  let batch = await f.create();
  for (const url of ['https://example.test/', 'javascript:alert(1)', 'aweme://other?id=1', 'aweme://playlet', 'aweme://user@playlet?id=1', 'aweme://playlet:8080?id=1', 'aweme://playlet/other?id=1', 'aweme://playlet?id=1#hash', 'aweme://playlet?id=%0a1']) {
    assert.equal((await f.patch(batch, { paidLink: { ...paidLink, url } })).status, 400, url);
  }
  assert.equal((await f.patch(batch, { paidLink: { ...paidLink, startEpisode: 0 } })).status, 400);
  assert.equal((await f.patch(batch, { paidLink, freeLink: paidLink })).status, 400);
  const saved = await f.patch(batch, { paidLink, freeLink });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); batch = saved.data.batch;
  assert.deepEqual(batch.items[0].paidLink, paidLink); assert.deepEqual(batch.items[0].freeLink, freeLink);
  assert.equal(batch.items[0].readiness.ready, false);
  assert.equal(batch.items[0].readiness.blockers.some(reason => /推广链/.test(reason)), false);
  const partial = await f.patch(batch, { freeLink: { url: freeLink.url } });
  assert.equal(partial.status, 200);
  assert.ok(partial.data.batch.items[0].readiness.blockers.includes('免费推广链待补全'));
  assert.equal(f.calls.length, 0);
});

test('revision compares and swaps prevent lost updates including simultaneous saves', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const batch = await f.create();
  const results = await Promise.all([f.patch(batch, { priority: 'high' }), f.patch(batch, { dailyBudget: 100 })]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  assert.equal((await f.patch(batch, { dailyBudget: 900 })).status, 409);
  const current = (await f.call('/release-batches')).data.batches[0];
  assert.equal(current.revision, 2);
  assert.ok(current.items[0].priority === 'high' && current.items[0].dailyBudget === 0 || current.items[0].priority === 'normal' && current.items[0].dailyBudget === 100);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM audit WHERE action='release_batch.item_updated'").get().count, 1);
});

test('readiness uses owned original assets and complete primary deliverables, manual verification and unresolved blockers', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  let batch = await f.create();
  const project = await f.repository.createProject('owner', { title: '剧目素材包' });
  const foreign = await f.repository.createProject('other', { title: '其他用户素材包' });
  assert.equal((await f.patch(batch, { projectId: foreign.id })).status, 404);
  assert.equal((await f.patch(batch, { projectId: 'missing-project' })).status, 404);
  await f.repository.createAsset('owner', { projectId: project.id, filename: 'source.mp4', mimeType: 'video/mp4', size: 300, objectKey: 'owner/source.mp4', status: 'uploaded' });
  const completed = await f.repository.createJob('owner', { projectId: project.id, employeeId: 'market-test', type: 'bxagi_workflow', status: 'completed', details: { resultCreativeIds: [] } });
  const running = await f.repository.createJob('owner', { projectId: project.id, employeeId: 'market-test', type: 'bxagi_workflow', status: 'running', details: { resultCreativeIds: [] } });
  const makeCreative = (name, metadata, overrides = {}) => f.repository.createCreative('owner', { projectId: project.id, filename: name, title: name, mimeType: 'video/mp4', size: 200, objectKey: `owner/${name}`, metadata, ...overrides });
  const main = await makeCreative('main.mp4', { sourceJobId: completed.id, deliverableRole: 'primary' });
  const cover = await makeCreative('cover.png', { sourceJobId: completed.id, deliverableRole: 'cover' }, { mimeType: 'image/png' });
  const partial = await makeCreative('partial.mp4', { sourceJobId: running.id, deliverableRole: 'primary' });
  const rejected = await makeCreative('rejected.mp4', { sourceJobId: completed.id, deliverableRole: 'primary' }, { status: 'rejected' });
  const duplicate = await makeCreative('duplicate-record.mp4', { sourceJobId: completed.id, deliverableRole: 'primary' }, { objectKey: main.objectKey });
  await f.repository.updateJob('owner', completed.id, { details: { resultCreativeIds: [main.id, cover.id, rejected.id, duplicate.id] } });
  await f.repository.updateJob('owner', running.id, { details: { resultCreativeIds: [partial.id] } });
  const first = await f.patch(batch, { projectId: project.id, releaseStatus: 'available', authorizationStatus: 'confirmed', paidLink, freeLink, dailyBudget: 100 });
  assert.equal(first.status, 200, JSON.stringify(first.data)); batch = first.data.batch;
  assert.equal(batch.items[0].readiness.sourceCount, 1); assert.equal(batch.items[0].readiness.creativeCount, 1);
  assert.deepEqual(batch.items[0].readiness.blockers, ['完整主成品 1/2']);
  assert.ok(Date.parse(batch.items[0].verifiedAt));
  await f.repository.updateJob('owner', running.id, { status: 'completed' });
  batch = (await f.call('/release-batches')).data.batches[0];
  assert.equal(batch.items[0].readiness.creativeCount, 2); assert.equal(batch.items[0].readiness.ready, true);
  assert.equal(batch.summary.ready, 1); assert.equal(batch.summary.blocked, 0);
  await f.repository.updateProject('owner', project.id, { sourceState: { version: 1, status: 'uploading', batchId: 'new-upload' } });
  const uploading = (await f.call('/release-batches')).data.batches[0];
  assert.equal(uploading.items[0].readiness.ready, false);
  assert.ok(uploading.items[0].readiness.blockers.includes('当前素材批次尚未上传完成'));
  await f.repository.updateProject('owner', project.id, { sourceState: { version: 1, status: 'sealed' } });
  await f.repository.updateJob('owner', running.id, { details: { resultCreativeIds: [partial.id], remoteWritePending: { operation: 'send' } } });
  assert.equal((await f.call('/release-batches')).data.batches[0].items[0].readiness.creativeCount, 1, 'uncertain production cannot count as complete');
  await f.repository.updateJob('owner', running.id, { details: { resultCreativeIds: [partial.id] } });
  const failed = await f.patch(batch, { failureStage: 'delivery', failureReason: '账户配置待核对' });
  assert.equal(failed.data.batch.items[0].readiness.ready, false);
  assert.ok(failed.data.batch.items[0].readiness.blockers.includes('账户配置待核对'));
  const cleared = await f.patch(failed.data.batch, { failureStage: '', failureReason: '' });
  assert.equal(cleared.data.batch.items[0].readiness.ready, true);
  const reset = await f.patch(cleared.data.batch, { authorizationStatus: 'unverified' });
  assert.equal(reset.data.batch.items[0].verifiedAt, null); assert.equal(reset.data.batch.items[0].readiness.ready, false);
  assert.equal(f.calls.length, 0, 'readiness and updates never generate links or launch ads');
});

test('budget edits preserve verification time while a changed drama identity invalidates verification', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  let batch = await f.create();
  batch = (await f.patch(batch, { releaseStatus: 'available', authorizationStatus: 'confirmed' })).data.batch;
  const verifiedAt = '2026-01-02T03:04:05.000Z';
  f.sqlite.prepare("UPDATE jobs SET details = json_set(details, '$.items[0].verifiedAt', ?) WHERE id = ?").run(verifiedAt, batch.id);
  batch = (await f.patch(batch, { dailyBudget: 300, releaseStatus: 'available', authorizationStatus: 'confirmed' })).data.batch;
  assert.equal(batch.items[0].verifiedAt, verifiedAt);
  batch = (await f.patch(batch, { title: '更换后的剧目', releaseStatus: 'available', authorizationStatus: 'confirmed' })).data.batch;
  assert.equal(batch.items[0].releaseStatus, 'unverified'); assert.equal(batch.items[0].authorizationStatus, 'unverified'); assert.equal(batch.items[0].verifiedAt, null);
});
