import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { connectionSummary } from '../server/adapters/connection-secrets.mjs';

function campaignFixture() {
  const saved = [];
  const project = { id: 'project-owned', userId: 'owner', title: '商品素材', scene: 'general', objective: 'purchase' };
  const creative = { id: 'creative-owned', userId: 'owner', projectId: project.id, status: 'draft' };
  const repository = {
    async listEmployeeProfiles() { return []; },
    async getProject(userId, id) { return userId === 'owner' && id === project.id ? project : null; },
    async getCreative(userId, id) { return userId === 'owner' && id === creative.id ? creative : null; },
    async createCampaign(userId, data) { const row = { id: 'new-campaign', userId, ...data }; saved.push(row); return row; },
    async addAudit() {},
  };
  async function create(platformConfig) {
    return handlePlatformRequest(new Request('https://app.test/api/v2/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, creativeIds: [creative.id], name: '素材投放', channel: 'oceanengine', dailyBudget: 20, totalBudget: 100, platformConfig }),
    }), {}, { repository,resolveBxagiContext:async(_request,_env,{required}={})=>required?{userId:'owner',subject:'fixture-bxagi-owner',profile:{id:'fixture-bxagi-owner',displayName:'测试用户'}}:null });
  }
  return { create, saved };
}

test('nested provider credentials cannot enter public campaign configuration', async () => {
  const fixture = campaignFixture();
  for (const key of ['accessToken', 'refresh_token', 'refreshToken', 'apiKey', 'api_key', 'clientSecret', 'secret', 'token', 'password', 'private_key']) {
    const result = await fixture.create({ project: { delivery_setting: { [key]: 'CREDENTIAL_MUST_STAY_SERVER_SIDE' } } });
    assert.equal(result.status, 400, `${key} must be rejected before creating an exportable campaign`);
  }
  assert.equal(fixture.saved.length, 0);
});

test('ordinary report mappings and budget unit remain valid public configuration', async () => {
  const fixture = campaignFixture();
  const config = { budgetUnit: 'yuan', report: { metrics: ['stat_cost'], dimensions: ['project_id'] }, metricMapping: { spend: 'stat_cost', projectId: 'project_id' } };
  const result = await fixture.create(config);
  assert.equal(result.status, 201);
  assert.deepEqual(fixture.saved[0].platformConfig, config);
});

test('invalid credential expiry cannot be displayed as a healthy authorization', () => {
  assert.equal(connectionSummary({ id: 'configured', secretsCiphertext: 'opaque', expiresAt: 'not-an-expiry' }).expired, true);
  assert.equal(connectionSummary({ id: 'configured', secretsCiphertext: 'opaque', expiresAt: '2099-01-01T00:00:00Z' }).expired, false);
});
