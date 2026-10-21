import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handlePlatformRequest } from '../server/platform-api.mjs';

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
  return { call, calls, sqlite };
}

test('settings API persists partial preferences through actual migrations and scopes users', async () => {
  const f = fixture();
  assert.equal((await f.call('/settings/preferences', { owner: null })).status, 401);
  const saved = await f.call('/settings/preferences', { method: 'PATCH', body: { displayName: '品牌负责人', notificationEmail: 'owner@example.test', preferences: { workspaceName: '眼镜品牌', notifyOnFailure: false } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.settings.displayName, '品牌负责人');
  await f.call('/settings/preferences', { method: 'PATCH', body: { preferences: { reportFrequency: 'weekly' } } });
  const own = await f.call('/settings/preferences'), other = await f.call('/settings/preferences', { owner: 'other' });
  assert.equal(own.data.settings.preferences.workspaceName, '眼镜品牌'); assert.equal(own.data.settings.preferences.notifyOnFailure, false); assert.equal(own.data.settings.preferences.reportFrequency, 'weekly');
  assert.equal(own.data.settings.emailVerified, false); assert.equal(own.data.settings.emailDeliveryAvailable, false); assert.equal(other.data.settings.displayName, '');
  assert.equal((await f.call('/bootstrap')).data.user.displayName, '品牌负责人');
  f.sqlite.close();
});

test('connection API create, edit, verify, disable and deletion use scoped durable rows', async () => {
  const f = fixture();
  const created = await f.call('/connections', { method: 'POST', body: { channel: 'volcano', accountId: 'model-project', accessToken: 'never-return-this-key' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.connection.id;
  const updated = await f.call(`/connections/${id}`, { method: 'PATCH', body: { label: '模型处理服务', accessToken: '' } });
  assert.equal(updated.status, 200); assert.equal(updated.data.connection.label, '模型处理服务'); assert.doesNotMatch(JSON.stringify(updated.data), /never-return|secretsCiphertext/);
  assert.equal((await f.call(`/connections/${id}`, { method: 'PATCH', owner: 'other', body: { label: 'other' } })).status, 404);
  const checked = await f.call(`/connections/${id}/test`, { method: 'POST', body: {} });
  assert.equal(checked.data.status, 'adapter_pending'); assert.equal(checked.data.verified, false); assert.equal(f.calls.length, 0);
  assert.equal((await f.call(`/connections/${id}/disable`, { method: 'POST', body: {} })).data.connection.status, 'disabled');
  assert.equal((await f.call(`/connections/${id}`, { method: 'DELETE', owner: 'other' })).status, 404);
  assert.equal((await f.call(`/connections/${id}`, { method: 'DELETE' })).data.deleted, true);
  assert.equal((await f.call('/connections')).data.connections.length, 0);
  f.sqlite.close();
});
