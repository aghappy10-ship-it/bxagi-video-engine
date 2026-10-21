import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsService } from '../server/settings-service.mjs';
import { encryptConnectionSecrets, decryptConnectionSecrets } from '../server/adapters/connection-secrets.mjs';

async function fixture({ channel = 'oceanengine', fetcher } = {}) {
  const env = { APP_ENCRYPTION_KEY: '42'.repeat(32) }, calls = [], audit = [], rows = new Map(), preferences = new Map(), campaigns = [];
  const connection = { id: 'connection-a', userId: 'owner', channel, accountId: '123456', label: 'Brand', appId: 'app-a', status: 'configured', expiresAt: '2099-01-01T00:00:00.000Z', secretsCiphertext: await encryptConnectionSecrets({ accessToken: 'original-private-token', appSecret: 'original-private-secret' }, env.APP_ENCRYPTION_KEY) };
  rows.set(connection.id, connection);
  const repository = {
    getConnection: async (u, id) => rows.get(id)?.userId === u ? structuredClone(rows.get(id)) : null,
    updateConnection: async (u, id, patch) => { const row = rows.get(id); assert.equal(row.userId, u); Object.assign(row, patch); return structuredClone(row); },
    deleteConnection: async (u, id) => { assert.equal(rows.get(id).userId, u); rows.delete(id); },
    listCampaigns: async u => campaigns.filter(row => row.userId === u),
    addAudit: async (u, row) => audit.push({ userId: u, ...row }),
    getPreferences: async u => preferences.get(u) || null,
    savePreferences: async (u, row) => { preferences.set(u, structuredClone(row)); return row; },
  };
  const service = createSettingsService({ repository, env, fetcher: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : Response.json({ code: 0, data: { list: [] }, request_id: 'read-proof' }); } });
  return { service, connection, repository, rows, calls, audit, campaigns, preferences, env };
}

test('connection management enforces owner isolation without upstream requests', async () => {
  const f = await fixture();
  for (const action of [() => f.service.updateConnection('other', f.connection.id, { label: 'changed' }), () => f.service.testConnection('other', f.connection.id), () => f.service.disableConnection('other', f.connection.id), () => f.service.deleteConnection('other', f.connection.id)]) await assert.rejects(action, error => error.status === 404);
  assert.equal(f.calls.length, 0); assert.equal(f.connection.label, 'Brand');
});

test('editing metadata retains encrypted credentials and never exposes credentials in response or audit', async () => {
  const f = await fixture(), ciphertext = f.connection.secretsCiphertext;
  const response = await f.service.updateConnection('owner', f.connection.id, { label: 'Renamed', accessToken: '', appSecret: '' });
  assert.equal(f.connection.secretsCiphertext, ciphertext); assert.equal(response.label, 'Renamed');
  assert.doesNotMatch(JSON.stringify({ response, audit: f.audit }), /original-private|secretsCiphertext/);
});

test('renewal rotates only provided secret, retains app secret and invalidates previous verification', async () => {
  const f = await fixture(); f.connection.status = 'verified';
  const response = await f.service.updateConnection('owner', f.connection.id, { accessToken: 'replacement-private-token', expiresAt: '2098-01-01T00:00:00.000Z' });
  const clear = await decryptConnectionSecrets(f.connection.secretsCiphertext, f.env.APP_ENCRYPTION_KEY);
  assert.equal(clear.accessToken, 'replacement-private-token'); assert.equal(clear.appSecret, 'original-private-secret'); assert.equal(response.status, 'configured');
  assert.doesNotMatch(JSON.stringify({ response, audit: f.audit }), /replacement-private|original-private/);
});

test('verification performs a single read and does not claim write permissions', async () => {
  const f = await fixture(); const result = await f.service.testConnection('owner', f.connection.id);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, 'GET');
  assert.match(f.calls[0].url, /^https:\/\/api\.oceanengine\.com\/open_api\/v3\.0\/project\/list\//);
  assert.equal(new URL(f.calls[0].url).searchParams.get('advertiser_id'), '123456');
  assert.equal(result.status, 'read_verified'); assert.match(result.message, /启动时检查/);
  assert.equal(f.connection.status, 'verified'); assert.equal(f.audit.at(-1).details.scope, 'project_read');
  assert.doesNotMatch(JSON.stringify(result), /original-private|secretsCiphertext/);
});

test('malformed or cross-account readback never produces verified status', async () => {
  for (const data of [{}, { list: [{ advertiser_id: 'other' }] }]) {
    const f = await fixture({ fetcher: async () => Response.json({ code: 0, data }) });
    f.connection.status = 'verified';
    await assert.rejects(() => f.service.testConnection('owner', f.connection.id), error => error.code === 'invalid_provider_response');
    assert.equal(f.connection.status, 'configured');
  }
});

test('pending adapters are truthful and send no requests', async () => {
  for (const channel of ['tencent', 'kuaishou', 'volcano', 'custom']) {
    const f = await fixture({ channel }); const result = await f.service.testConnection('owner', f.connection.id);
    assert.equal(result.status, 'adapter_pending'); assert.equal(result.verified, false); assert.equal(f.calls.length, 0);
  }
});

test('expired and disabled connections do not call the provider', async () => {
  const f = await fixture(); f.connection.expiresAt = '2000-01-01T00:00:00Z';
  await assert.rejects(() => f.service.testConnection('owner', f.connection.id), error => error.code === 'credentials_expired');
  f.connection.status = 'disabled';
  await assert.rejects(() => f.service.testConnection('owner', f.connection.id), error => error.code === 'connection_disabled');
  assert.equal(f.calls.length, 0);
});

test('active and uncertain operations retain their connection; any history prevents deletion and account swapping', async () => {
  const f = await fixture(); f.campaigns.push({ id: 'campaign', userId: 'owner', connectionId: f.connection.id, status: 'active' });
  await assert.rejects(() => f.service.disableConnection('owner', f.connection.id), error => error.code === 'connection_in_use');
  f.campaigns[0].status = 'paused'; f.campaigns[0].remoteState = { writePending: true };
  await assert.rejects(() => f.service.disableConnection('owner', f.connection.id), error => error.code === 'connection_in_use');
  f.campaigns[0].remoteState = {};
  assert.equal((await f.service.disableConnection('owner', f.connection.id)).status, 'disabled');
  await assert.rejects(() => f.service.deleteConnection('owner', f.connection.id), error => error.code === 'connection_in_use');
  await assert.rejects(() => f.service.updateConnection('owner', f.connection.id, { accountId: '9999' }), error => error.code === 'connection_in_use');
});

test('unbound connections can be disabled, re-enabled and deleted without provider mutations', async () => {
  const f = await fixture();
  assert.equal((await f.service.disableConnection('owner', f.connection.id)).status, 'disabled');
  assert.equal((await f.service.updateConnection('owner', f.connection.id, { status: 'configured' })).status, 'configured');
  assert.equal((await f.service.deleteConnection('owner', f.connection.id)).deleted, true);
  assert.equal(f.rows.size, 0); assert.equal(f.calls.length, 0);
});

test('connection guards inspect bindings beyond the first 500 dashboard campaigns', async () => {
  const f = await fixture();
  for (let index = 0; index < 500; index++) f.campaigns.push({ id: `new-${index}`, userId: 'owner', connectionId: 'unrelated', status: 'draft' });
  f.campaigns.push({ id: 'old-bound-live', userId: 'owner', connectionId: f.connection.id, status: 'active' });
  f.repository.listCampaigns = async userId => f.campaigns.filter(row => row.userId === userId).slice(0, 500);
  f.repository.listCampaignsByConnection = async (userId, connectionId) => f.campaigns.filter(row => row.userId === userId && row.connectionId === connectionId);
  await assert.rejects(() => f.service.deleteConnection('owner', f.connection.id), error => error.code === 'connection_in_use');
  await assert.rejects(() => f.service.disableConnection('owner', f.connection.id), error => error.code === 'connection_in_use');
  await assert.rejects(() => f.service.updateConnection('owner', f.connection.id, { accountId: '9999' }), error => error.code === 'connection_in_use');
  assert.equal(f.connection.status, 'configured'); assert.equal(f.rows.size, 1); assert.equal(f.calls.length, 0);
});

test('preferences are durable per owner, merged on partial update, and mail remains explicitly unavailable', async () => {
  const f = await fixture();
  await f.service.savePreferences('owner', { displayName: '我的工作区', notificationEmail: 'owner@example.test', preferences: { workspaceName: '品牌 A', notifyOnFailure: false } });
  await f.service.savePreferences('owner', { preferences: { reportFrequency: 'weekly' } });
  const settings = await f.service.getPreferences('owner'), other = await f.service.getPreferences('other');
  assert.equal(settings.preferences.workspaceName, '品牌 A'); assert.equal(settings.preferences.notifyOnFailure, false); assert.equal(settings.preferences.reportFrequency, 'weekly');
  assert.equal(settings.emailVerified, false); assert.equal(settings.emailDeliveryAvailable, false); assert.equal(other.displayName, '');
  assert.doesNotMatch(JSON.stringify(f.audit), /owner@example|品牌 A/);
});

test('invalid settings fail before persistence', async () => {
  const f = await fixture();
  for (const input of [{ notificationEmail: 'bad-email' }, { displayName: 'name\nmalformed' }, { preferences: { timezone: 'not-a-timezone' } }, { preferences: { reportFrequency: 'minutely' } }, { preferences: { notifyOnBudget: 'true' } }]) await assert.rejects(() => f.service.savePreferences('owner', input), error => error.code === 'settings_invalid');
  assert.equal(f.preferences.size, 0);
});
