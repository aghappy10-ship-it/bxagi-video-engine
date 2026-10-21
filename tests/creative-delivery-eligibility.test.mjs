import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCreativeDeliveryComplete } from '../server/creative-delivery-eligibility.mjs';
import { createAdsService } from '../server/ads-service.mjs';

const owner = 'tenant-a';
const creative = () => ({ id: 'creative-a', userId: owner, projectId: 'project-a', status: 'approved', reviewedAt: '2026-10-15T00:00:00Z', mimeType: 'image/png', metadata: { sourceJobId: 'job-a' } });
const job = () => ({ id: 'job-a', userId: owner, projectId: 'project-a', type: 'bxagi_workflow', status: 'completed', details: { resultCreativeIds: ['creative-a'] } });
const check = (source, output = creative()) => assertCreativeDeliveryComplete({ repository: { async getJob(userId, id) { assert.equal(userId, owner); assert.equal(id, 'job-a'); return source; } }, userId: owner, creative: output });

test('partial or unrelated production cannot become launchable merely by approving its saved file', async () => {
  for (const change of [row => { row.status = 'awaiting_result'; }, row => { row.status = 'failed'; }, row => { row.userId = 'tenant-b'; }, row => { row.projectId = 'project-b'; }, row => { row.details.resultCreativeIds = ['old-output']; }, row => { delete row.details.resultCreativeIds; }, row => { row.details.remoteWritePending = 'send'; }, row => { row.details.coordination = { dispatchOutcomeUnknown: true }; }, row => { row.details.videoFormatRepair = { phase: 'sending' }; }]) {
    const source = job(); change(source);
    await assert.rejects(check(source), error => error.code === 'bxagi_delivery_incomplete' && error.status === 409 && error.uncertain === false);
  }
  await assert.rejects(check(null), error => error.code === 'bxagi_delivery_incomplete');
  assert.equal((await check(job())).id, 'creative-a');
});

test('manual uploads and the existing completed full-decode video worker retain their explicit paths', async () => {
  const manual = creative(); delete manual.metadata.sourceJobId;
  assert.equal(await assertCreativeDeliveryComplete({ userId: owner, creative: manual }), manual);
  const local = job(); local.type = 'video_optimize'; local.details = { resultCreativeId: 'creative-a', output: { fullDecodePassed: true } };
  const video = { ...creative(), validation: 'worker-full-decode' };
  assert.equal(await check(local, video), video);
  local.details.output.fullDecodePassed = false;
  await assert.rejects(check(local, video), error => error.code === 'bxagi_delivery_incomplete');
  const malformed = creative(); malformed.metadata.sourceJobId = null;
  await assert.rejects(check(job(), malformed), error => error.code === 'bxagi_delivery_incomplete');
});

function launchFixture({ resume = false, partialCover = false } = {}) {
  const campaign = { id: 'campaign-a', userId: owner, projectId: 'project-a', creativeIds: ['creative-a'], status: resume ? 'paused' : 'draft', remoteId: resume ? 'remote-project' : null, remoteState: resume ? { projectId: 'remote-project', promotionIds: ['promotion'] } : {}, platformConfig: partialCover ? { coverCreativeId: 'cover-a' } : {} };
  const primary = { ...creative(), ...(partialCover ? { mimeType: 'video/mp4', metadata: {} } : {}) };
  const cover = { ...creative(), id: 'cover-a' };
  let providerCalls = 0, objectReads = 0; const audits = [];
  const repository = {
    getCampaign: async () => structuredClone(campaign),
    claimCampaignLaunch: async () => { campaign.status = 'launching'; return structuredClone(campaign); },
    claimCampaignOperation: async () => structuredClone(campaign),
    releaseCampaignOperation: async () => {},
    updateCampaign: async (_user, _id, patch) => Object.assign(campaign, structuredClone(patch)),
    listCreatives: async () => [primary], getCreative: async () => cover,
    getJob: async (userId, id) => { assert.equal(userId, owner); assert.equal(id, 'job-a'); return { ...job(), status: 'awaiting_result' }; },
    addAudit: async (_user, row) => { audits.push(row); },
  };
  const service = createAdsService({ repository, bucket: { get: async () => { objectReads++; return null; } }, fetcher: async () => { providerCalls++; throw new Error('provider must not be called'); } });
  return { service, campaign, audits, counts: () => ({ providerCalls, objectReads }) };
}

test('real ads launch and resume reject partial production before provider calls', async () => {
  for (const resume of [false, true]) {
    const f = launchFixture({ resume });
    const result = await f.service.launch(owner, f.campaign);
    assert.equal(resume ? f.audits.at(-1).details.code : result.remoteState.errorCode, 'bxagi_delivery_incomplete');
    assert.equal(result.status, resume ? 'paused' : 'blocked');
    assert.deepEqual(f.counts(), { providerCalls: 0, objectReads: 0 });
  }
});

test('an incomplete generated cover is independently rejected before media reads', async () => {
  const f = launchFixture({ partialCover: true });
  const result = await f.service.launch(owner, f.campaign);
  assert.equal(result.remoteState.errorCode, 'bxagi_delivery_incomplete');
  assert.deepEqual(f.counts(), { providerCalls: 0, objectReads: 0 });
});
