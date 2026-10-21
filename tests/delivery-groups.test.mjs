import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateDeliveryBudgets, createDeliveryGroupService, assertDeliveryGroupAllocation, withDeliveryGroupLock, deliveryGroupStatus } from '../server/delivery-groups.mjs';

const U = 'owner-a';
function fixture() {
  const groupRows = [], campaigns = [], audits = [], locks = new Map();
  const project = { id: 'pack', userId: U, title: '眼镜素材包', objective: 'purchase' };
  const creatives = ['a', 'b', 'c'].map(id => ({ id, userId: U, projectId: project.id, mimeType: 'image/png', title: id, status: 'approved', reviewedAt: '2026-10-15' }));
  const connection = { id: 'account', userId: U, channel: 'oceanengine' };
  const clone = value => value ? structuredClone(value) : null;
  const scoped = (rows, u, id) => rows.find(row => row.id === id && row.userId === u);
  const repo = {
    getProject: async (u, id) => clone(scoped([project], u, id)),
    getCreative: async (u, id) => clone(scoped(creatives, u, id)),
    getConnection: async (u, id) => clone(scoped([connection], u, id)),
    getDeliveryGroup: async (u, id) => clone(scoped(groupRows, u, id)),
    getDeliveryGroupByProject: async (u, id) => clone(groupRows.find(row => row.userId === u && row.projectId === id)),
    createDeliveryGroup: async (u, data) => { if (groupRows.some(row => row.userId === u && row.projectId === data.projectId)) throw new Error('unique'); const row = { id: `group-${groupRows.length}`, userId: u, ...data }; groupRows.push(row); return clone(row); },
    updateDeliveryGroup: async (u, id, patch) => { const row = scoped(groupRows, u, id); if (!row) return null; Object.assign(row, clone(patch)); return clone(row); },
    claimDeliveryGroupOperation: async (u, id, op) => { const row = scoped(groupRows, u, id); if (!row || locks.has(id)) return null; locks.set(id, op); return clone(row); },
    releaseDeliveryGroupOperation: async (u, id, op) => { assert.equal(u, U); if (locks.get(id) === op) locks.delete(id); },
    listCampaigns: async u => clone(campaigns.filter(row => row.userId === u)),
    createCampaign: async (u, data) => { const row = { id: `unit-${campaigns.length}`, userId: u, ...data }; campaigns.push(row); return clone(row); },
    addAudit: async (u, row) => { assert.equal(u, U); audits.push(clone(row)); return row; },
  };
  const input = { projectId: 'pack', creativeIds: ['a', 'b', 'c'], channel: 'oceanengine', connectionId: 'account', dailyBudget: 300, totalBudget: 1500, targetRoi: 1.5 };
  return { repo, input, project, creatives, connection, groups: groupRows, campaigns, audits, locks, service: createDeliveryGroupService({ repository: repo }) };
}

test('three children divide the shared amount once, preserving every cent', () => {
  const rows = allocateDeliveryBudgets(['a', 'b', 'c'], { dailyBudget: 100, totalBudget: 1000 });
  assert.deepEqual(rows.map(row => row.dailyBudget), [33.34, 33.33, 33.33]);
  assert.equal(rows.reduce((s, row) => s + Math.round(row.totalBudget * 100), 0), 100000);
  assert.throws(() => allocateDeliveryBudgets(['a', 'b'], { dailyBudget: 0.001, totalBudget: 1 }), /两位/);
});

test('custom allocation cannot multiply group budgets or omit a selected creative', () => {
  assert.throws(() => allocateDeliveryBudgets(['a', 'b'], { dailyBudget: 100, totalBudget: 200, allocations: [{ creativeId: 'a', dailyBudget: 100, totalBudget: 100 }, { creativeId: 'b', dailyBudget: 100, totalBudget: 100 }] }), error => error.code === 'delivery_group_budget_exceeded');
  assert.throws(() => allocateDeliveryBudgets(['a', 'b'], { dailyBudget: 100, totalBudget: 200, allocations: [{ creativeId: 'a', dailyBudget: 100, totalBudget: 200 }] }), error => error.code === 'invalid_allocations');
});

test('creation stores three independent drafts and retries without duplicate units or remote work', async () => {
  const f = fixture(), result = await f.service.create(U, f.input);
  assert.equal(result.partial, false); assert.equal(result.campaigns.length, 3);
  assert.deepEqual(result.campaigns.map(row => row.creativeIds), [['a'], ['b'], ['c']]);
  assert.ok(result.campaigns.every(row => row.status === 'draft' && !row.remoteId && row.dailyBudget === 100));
  assert.equal(result.campaigns[0].remoteState.deliveryUnit.initialDailyBudget, 100);
  const repeated = await f.service.create(U, { ...f.input, platformConfig: {} });
  assert.ok(repeated.results.every(row => row.existing)); assert.equal(f.campaigns.length, 3); assert.equal(f.locks.size, 0);
});

test('partial local creation is explicit and only missing drafts are recovered', async () => {
  const f = fixture(), create = f.repo.createCampaign; let failed = false;
  f.repo.createCampaign = async (u, data) => { if (data.creativeIds[0] === 'b' && !failed) { failed = true; throw new Error('storage unavailable with secret'); } return create(u, data); };
  const first = await f.service.create(U, f.input);
  assert.equal(first.partial, true); assert.equal(first.group.status, 'draft_partial'); assert.equal(first.campaigns.length, 2);
  assert.ok(!JSON.stringify(first).includes('secret'));
  const retry = await f.service.create(U, f.input);
  assert.equal(retry.partial, false); assert.equal(retry.campaigns.length, 3); assert.equal(new Set(f.campaigns.map(row => row.unitKey)).size, 3);
});

test('owners, accounts, auxiliary files and differing definitions are rejected before new drafts', async () => {
  const f = fixture(); await assert.rejects(() => f.service.create('owner-b', f.input), error => error.code === 'not_found');
  f.connection.userId = 'owner-b'; await assert.rejects(() => f.service.create(U, f.input), error => error.code === 'connection_missing'); f.connection.userId = U;
  f.creatives[0].metadata = { deliverableRole: 'cover' }; await assert.rejects(() => f.service.create(U, f.input), error => error.code === 'invalid_creative'); delete f.creatives[0].metadata;
  await f.service.create(U, f.input);
  await assert.rejects(() => f.service.create(U, { ...f.input, dailyBudget: 301 }), error => error.code === 'delivery_group_exists');
  assert.equal(f.campaigns.length, 3);
});

test('reserved draft and paused budgets constrain every increase and reject uncertain siblings', async () => {
  const f = fixture(); await f.service.create(U, f.input); const first = f.campaigns[0];
  f.campaigns[1].status = 'paused';
  await assert.rejects(() => assertDeliveryGroupAllocation(f.repo, U, first, { dailyBudget: 101 }), error => error.code === 'delivery_group_budget_exceeded');
  f.campaigns[1].dailyBudget = 50;
  const result = await assertDeliveryGroupAllocation(f.repo, U, first, { dailyBudget: 120 }); assert.equal(result.dailyBudget, 270);
  f.campaigns[1].status = 'needs_reconciliation';
  await assert.rejects(() => assertDeliveryGroupAllocation(f.repo, U, first, { dailyBudget: 120 }), error => error.code === 'delivery_group_reconciliation_required');
  await assert.rejects(() => assertDeliveryGroupAllocation(f.repo, U, first), error => error.code === 'delivery_group_reconciliation_required');
});

test('group lock prevents concurrent cross-unit allocations and is released after rejection', async () => {
  const f = fixture(); const { group } = await f.service.create(U, f.input);
  let unlock; const barrier = new Promise(resolve => { unlock = resolve; });
  const first = withDeliveryGroupLock(f.repo, U, group.id, async () => { await barrier; throw new Error('operation stopped'); });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => withDeliveryGroupLock(f.repo, U, group.id, () => {}), error => error.code === 'delivery_group_busy');
  unlock(); await assert.rejects(() => first, /stopped/); assert.equal(f.locks.size, 0);
  await withDeliveryGroupLock(f.repo, U, group.id, () => assert.equal(f.locks.size, 1));
});

test('group cap edits never rewrite or start child campaigns', async () => {
  const f = fixture(); const { group } = await f.service.create(U, f.input);
  await assert.rejects(() => f.service.updateBudget(U, group.id, { dailyBudget: 299, totalBudget: 1500 }), error => error.code === 'delivery_group_budget_exceeded');
  const updated = await f.service.updateBudget(U, group.id, { dailyBudget: 400, totalBudget: 2000 });
  assert.equal(updated.group.dailyBudget, 400); assert.ok(f.campaigns.every(row => row.dailyBudget === 100 && row.status === 'draft'));
});

test('group operation calls the supplied employee workflow independently and preserves partial results', async () => {
  const f = fixture(); const { group } = await f.service.create(U, f.input); const calls = [];
  const result = await f.service.operate(U, group.id, 'launch', async (campaign, action) => { calls.push([campaign.id, action]); if (campaign.creativeIds[0] === 'b') throw new Error('failed'); return { provider: 'bxagi', queued: true, job: { id: `job-${campaign.id}` } }; });
  assert.equal(calls.length, 3); assert.equal(result.partial, true); assert.equal(result.results.filter(row => row.queued).length, 2); assert.ok(f.campaigns.every(row => row.status === 'draft'));
  assert.equal(deliveryGroupStatus([{ status: 'active' }, { status: 'blocked' }]), 'partial');
  assert.equal(deliveryGroupStatus([{ status: 'active' }, { status: 'needs_reconciliation' }]), 'needs_reconciliation');
});

test('explicit append creates a new round without replacing or starting older creative units', async () => {
  const f = fixture(); const { group } = await f.service.create(U, f.input); const originalIds = f.campaigns.map(row => row.id);
  await f.service.updateBudget(U, group.id, { dailyBudget: 500, totalBudget: 2500 });
  const request = { ...f.input, creativeIds: ['a', 'b'], dailyBudget: 200, totalBudget: 1000, versionRound: 2, requestId: 'request-round-two' };
  const appended = await f.service.append(U, group.id, request);
  assert.equal(appended.campaigns.length, 5); assert.equal(appended.partial, false); assert.equal(appended.group.dailyBudget, 500);
  assert.deepEqual(f.campaigns.slice(0, 3).map(row => row.id), originalIds); assert.ok(f.campaigns.every(row => row.status === 'draft'));
  assert.ok(f.campaigns.slice(3).every(row => row.remoteState.deliveryUnit.round === 2 && row.dailyBudget === 100));
  const retry = await f.service.append(U, group.id, request); assert.equal(retry.campaigns.length, 5); assert.ok(retry.results.every(row => row.existing));
  await assert.rejects(() => f.service.append(U, group.id, { ...request, dailyBudget: 201 }), error => error.code === 'delivery_request_conflict');
  await assert.rejects(() => f.service.append(U, group.id, { ...request, requestId: 'different-request' }), error => error.code === 'delivery_unit_exists');
});

test('append cannot exceed unallocated pack capacity or borrow another owner creative', async () => {
  const f = fixture(); const { group } = await f.service.create(U, f.input);
  const request = { ...f.input, creativeIds: ['a'], dailyBudget: 100, totalBudget: 500, versionRound: 2, requestId: 'request-round-two' };
  await assert.rejects(() => f.service.append(U, group.id, request), error => error.code === 'delivery_group_budget_exceeded');
  assert.equal(f.campaigns.length, 3);
  await f.service.updateBudget(U, group.id, { dailyBudget: 400, totalBudget: 2000 });
  f.creatives[0].userId = 'owner-b'; await assert.rejects(() => f.service.append(U, group.id, request), error => error.code === 'invalid_creative'); assert.equal(f.campaigns.length, 3);
});

test('partial append resumes missing units with the same request and never duplicates a success', async () => {
  const f = fixture(); const { group } = await f.service.create(U, f.input);
  await f.service.updateBudget(U, group.id, { dailyBudget: 500, totalBudget: 2500 });
  const request = { ...f.input, creativeIds: ['a', 'b'], dailyBudget: 200, totalBudget: 1000, versionRound: 2, requestId: 'partial-append-1' };
  const create = f.repo.createCampaign; let failed = false;
  f.repo.createCampaign = async (u, data) => { if (data.creativeIds[0] === 'b' && !failed) { failed = true; throw new Error('unavailable'); } return create(u, data); };
  const first = await f.service.append(U, group.id, request); assert.equal(first.partial, true); assert.equal(first.campaigns.length, 4);
  const retry = await f.service.append(U, group.id, request); assert.equal(retry.partial, false); assert.equal(retry.campaigns.length, 5); assert.equal(new Set(f.campaigns.map(row => row.unitKey)).size, 5);
});

test('financial checks use complete group queries rather than truncated dashboard campaigns', async () => {
  const f = fixture(); const { group } = await f.service.create(U, f.input);
  f.repo.listCampaigns = async () => []; // A dashboard page can omit every older unit.
  f.repo.listCampaignsByGroup = async (u, id) => { assert.equal(u, U); assert.equal(id, group.id); return structuredClone(f.campaigns); };
  await assert.rejects(() => assertDeliveryGroupAllocation(f.repo, U, f.campaigns[0], { dailyBudget: 101 }), error => error.code === 'delivery_group_budget_exceeded');
  await assert.rejects(() => f.service.updateBudget(U, group.id, { dailyBudget: 299, totalBudget: 1500 }), error => error.code === 'delivery_group_budget_exceeded');
  await assert.rejects(() => f.service.append(U, group.id, { ...f.input, creativeIds: ['a'], dailyBudget: 100, totalBudget: 500, versionRound: 2, requestId: 'full-list-regression' }), error => error.code === 'delivery_group_budget_exceeded');
  assert.equal(f.campaigns.length, 3);
});
