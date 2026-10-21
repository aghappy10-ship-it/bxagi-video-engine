import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createBxagiMarketActivation } from '../server/bxagi-market-activation.mjs';

const origin = 'https://bxagi.xinlx.com';
const secret = 'activation-fixture-credential';
const context = { userId: 'activation-owner', nativeUserId: 'activation-owner', subject: 'verified-bxagi-owner', accessToken: secret };
const marketId = 'creative-editor';
const employee = {
  id: `bxagi:market:${marketId}`, marketId, name: '素材剪辑员工', category: '创意', marketVerified: true,
  provider: 'bxagi',
  resourceType: 'marketplace_template', hasSubs: false, installed: false, installation: null,
  sourceVerified: false, usable: false, activationState: 'not_installed',
  activation: { required: true, freeVerified: false, quote: { monthly: 39, annual: 299, currency: 'CNY' }, reason: 'quota_available_but_not_price_locked' },
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const clone = value => structuredClone(value);

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...args) { return {
      async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    }; } };
  } };
}

function fixture({ catalogEmployee = employee, snapshots, mode = true, quota = { remaining: 1, quota: 3 }, details, nodes, post, repositoryWrapper } = {}) {
  const DB = database();
  const realRepository = createPlatformRepository(DB);
  const repository = repositoryWrapper ? repositoryWrapper(realRepository) : realRepository;
  const calls = [], timeline = [];
  let inspectionCount = 0;
  const marketplace = {
    async inspect() {
      timeline.push('inspect');
      const index = inspectionCount++;
      return clone(snapshots ? snapshots[Math.min(index, snapshots.length - 1)] : { employees: [catalogEmployee], isCloudMode: mode, quota });
    },
    async readTemplateDetails(id) {
      timeline.push('details');
      assert.equal(id, marketId);
      return clone(details || { marketId, scheduleCount: 0, schedules: [] });
    },
  };
  const api = createBxagiMarketActivation({ repository, context: { ...context }, fetcher: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    calls.push({ url: parsed, options });
    if (parsed.pathname === '/api/nodes') {
      timeline.push('nodes');
      assert.equal(options.method, 'GET');
      assert.equal(parsed.searchParams.has('include_shared'), false);
      return json(nodes || { nodes: [{ node_id: 'owned-node', status: 'online', gateway_connected: true }] });
    }
    assert.equal(parsed.pathname, '/api/v1/employees/install');
    assert.equal(options.method, 'POST');
    timeline.push('install');
    return post ? post({ repository: realRepository, options, parsed, timeline }) : json({ main_conversation_id: 'new-employee-conversation' });
  } });
  return { DB, repository, realRepository, marketplace, api, calls, timeline, inspectionCount: () => inspectionCount,
    async activate(selected = employee) { return api.activate(clone(selected), { marketplace }); },
    async job() { return realRepository.getBxagiMarketActivation(context.userId, marketId, context.subject); },
    close() { DB.sqlite.close(); },
  };
}

test('quota activation uses fresh market state, the owned node, and the exact observed install payload', async () => {
  let pending;
  const f = fixture({ post: async ({ repository, options }) => {
    pending = await repository.getBxagiMarketActivation(context.userId, marketId, context.subject);
    assert.ok(pending, 'Activation must exist durably before the remote write');
    assert.equal(pending.status, 'activating');
    assert.equal(pending.details.remoteWritePending, 'install_market_employee');
    assert.deepEqual(JSON.parse(options.body), { template_id: marketId, name: employee.name, node_id: 'owned-node', primary_agent_name: employee.name, department: employee.category, period: 'monthly', locale: 'zh' });
    return json({ main_conversation_id: 'new-employee-conversation' });
  } });
  try {
    const result = await f.activate();
    assert.equal(result.status, 'starting');
    assert.equal(result.marketId, marketId);
    assert.equal(result.conversationId, 'new-employee-conversation');
    assert.equal(result.jobId, pending.id);
    assert.ok(f.inspectionCount() >= 2);
    assert.equal(f.timeline[f.timeline.indexOf('install') - 1], 'inspect');
    assert.ok(f.timeline.indexOf('details') < f.timeline.indexOf('install'));
    const saved = await f.job();
    assert.equal(saved.status, 'activated');
    assert.equal(saved.details.mainConversationId, 'new-employee-conversation');
    assert.equal(saved.details.remoteWritePending, null);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(saved).includes(secret));
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  } finally { f.close(); }
});

test('an already usable and source-verified employee returns activated without installing again', async () => {
  const ready = { ...clone(employee), installed: true, sourceVerified: true, usable: true, activationState: 'ready', resourceType: 'installed_employee', conversationId: 'owned-existing-conversation', installation: { providerId: marketId, conversationId: 'owned-existing-conversation', status: 'active', usable: true, conversationExists: true }, activation: { ...employee.activation, required: false } };
  const f = fixture({ catalogEmployee: ready });
  try {
    const result = await f.activate();
    assert.equal(result.status, 'activated');
    assert.equal(result.conversationId, ready.conversationId);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.job(), null);
  } finally { f.close(); }
});

test('team, expired, unavailable installed, and mismatched market selections cannot auto-install', async () => {
  for (const catalogEmployee of [
    { ...employee, hasSubs: true },
    { ...employee, hasSubs: null },
    { ...employee, marketVerified: false },
    { ...employee, id: 'bxagi:creative-editor' },
    { ...employee, installed: true, installation: { status: 'expired', usable: false, conversationExists: true } },
    { ...employee, installed: true, installation: { status: 'active', usable: false, conversationExists: true } },
  ]) {
    const f = fixture({ catalogEmployee });
    try {
      const result = await f.activate();
      assert.equal(result.status, 'blocked');
      assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
    } finally { f.close(); }
  }
});

test('a vanished quota blocks installation at the second inspection without spending', async () => {
  const f = fixture({ snapshots: [
    { employees: [employee], isCloudMode: true, quota: { remaining: 1, quota: 3 } },
    { employees: [employee], isCloudMode: true, quota: { remaining: 0, quota: 3 } },
  ] });
  try {
    const result = await f.activate();
    assert.equal(result.status, 'blocked');
    assert.equal(f.inspectionCount(), 2);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
  } finally { f.close(); }
});

test('only explicit private mode or a verified numeric zero quote can bypass a missing quota', async () => {
  for (const config of [
    { mode: false, quota: null, allowed: true },
    { mode: true, quota: { remaining: 0, quota: 3 }, catalogEmployee: { ...employee, activation: { ...employee.activation, freeVerified: true, quote: { monthly: 0, annual: 0, currency: 'CNY' } } }, allowed: true },
    { mode: null, quota: null, allowed: false },
    { mode: true, quota: { remaining: 0, quota: 3 }, catalogEmployee: { ...employee, activation: { ...employee.activation, freeVerified: true, quote: { monthly: '0', annual: '0', currency: 'CNY' } } }, allowed: false },
    { mode: true, quota: null, catalogEmployee: { ...employee, activation: { ...employee.activation, freeVerified: false, quote: { monthly: 0, annual: 0, currency: 'CNY' } } }, allowed: false },
  ]) {
    const f = fixture(config);
    try {
      const result = await f.activate();
      assert.equal(result.status, config.allowed ? 'starting' : 'blocked');
      assert.equal(f.calls.filter(call => call.options.method === 'POST').length, config.allowed ? 1 : 0);
    } finally { f.close(); }
  }
});

test('templates with automatic schedules or unverifiable details cannot be installed', async () => {
  for (const details of [
    { marketId, scheduleCount: 1, schedules: [{ cron: '* * * * *', prompt: 'run automatically' }] },
    { marketId, scheduleCount: 0, schedules: [{ cron: '* * * * *' }] },
    { marketId: 'some-other-template', scheduleCount: 0, schedules: [] },
    { marketId, scheduleCount: null, schedules: [] },
  ]) {
    const f = fixture({ details });
    try {
      assert.equal((await f.activate()).status, 'blocked');
      assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
    } finally { f.close(); }
  }
});

test('offline or disconnected nodes and unobserved node envelopes cannot authorize installation', async () => {
  for (const [nodes, expectedStatus] of [
    [{ nodes: [] }, 'wait'],
    [{ nodes: [{ node_id: 'owned-node', status: 'offline', gateway_connected: true }] }, 'wait'],
    [{ nodes: [{ node_id: 'owned-node', status: 'online', gateway_connected: false }] }, 'wait'],
    [[{ node_id: 'owned-node', status: 'online', gateway_connected: true }], 'blocked'],
  ]) {
    const f = fixture({ nodes });
    try {
      assert.equal((await f.activate()).status, expectedStatus);
      assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
    } finally { f.close(); }
  }
});

test('same-owner concurrent callers share a durable reservation and issue at most one install', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.activate(), f.activate()]);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
    assert.equal(results.filter(result => result.status === 'starting').length, 1);
    assert.ok(results.every(result => ['starting', 'wait', 'needs_reconciliation'].includes(result.status)));
    assert.equal((await f.realRepository.listJobs(context.userId)).length, 1);
    const job = await f.job();
    assert.equal(await f.realRepository.getBxagiMarketActivation('different-native-owner', marketId, context.subject), null);
    assert.equal(await f.realRepository.getBxagiMarketActivation(context.userId, marketId, 'different-bxagi-owner'), null);
    assert.equal(await f.realRepository.getJob('different-native-owner', job.id), null);
  } finally { f.close(); }
});

test('the actual repository serializes different templates per owner and uncertainty never releases that guard', async () => {
  const DB = database();
  const repository = createPlatformRepository(DB);
  const reserve = (id, operationId, userId = context.userId, subject = context.subject) => repository.reserveBxagiMarketActivation(userId, { marketId: id, bxagiSubject: subject, operationId });
  try {
    const requests = [{ marketId: 'template-a', operationId: 'operation-a' }, { marketId: 'template-b', operationId: 'operation-b' }];
    const results = await Promise.all(requests.map(request => reserve(request.marketId, request.operationId)));
    assert.equal(results.filter(result => result.claimed).length, 1);
    const winner = results.find(result => result.claimed);
    const loserIndex = results.findIndex(result => !result.claimed);
    assert.equal(results[loserIndex].job, null);
    assert.equal((await repository.listJobs(context.userId)).length, 1);
    assert.equal(await repository.getBxagiMarketActivation('different-owner', winner.job.details.marketId, context.subject), null);
    assert.equal(await repository.getBxagiMarketActivation(context.userId, winner.job.details.marketId, 'different-subject'), null);
    assert.equal(await repository.updateJob('different-owner', winner.job.id, { status: 'activated' }), null);

    await repository.updateJob(context.userId, winner.job.id, { status: 'activated', details: { ...winner.job.details, mainConversationId: 'actual-conversation', remoteWritePending: null } });
    const next = await reserve(requests[loserIndex].marketId, 'operation-after-activation');
    assert.equal(next.claimed, true);
    assert.equal(next.job.details.marketId, requests[loserIndex].marketId);

    await repository.updateJob(context.userId, next.job.id, { status: 'needs_reconciliation', details: { ...next.job.details, remoteWritePending: 'install_market_employee' } });
    DB.sqlite.prepare('UPDATE jobs SET updatedAt = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', next.job.id);
    const blocked = await reserve('template-c', 'operation-much-later');
    assert.equal(blocked.claimed, false);
    assert.equal(blocked.job, null);
    const changedSubject = await reserve('template-d', 'operation-new-subject', context.userId, 'another-bxagi-subject');
    assert.equal(changedSubject.claimed, false);
    assert.equal(changedSubject.job, null);
    const separateOwner = await reserve('template-c', 'operation-other-owner', 'different-owner');
    assert.equal(separateOwner.claimed, true);
    assert.equal(separateOwner.job.userId, 'different-owner');
    assert.equal(await repository.getJob(context.userId, separateOwner.job.id), null);
  } finally { DB.sqlite.close(); }
});

test('uncertain remote writes are permanent until reconciliation and never retried automatically', async () => {
  const failures = [
    () => { throw new Error(`network failure ${secret}`); },
    () => new Response(`upstream failure ${secret}`, { status: 500 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://external.invalid/token-target' } }),
    () => json({}),
    () => json({ main_conversation_id: '../invalid' }),
  ];
  for (const post of failures) {
    const f = fixture({ post });
    try {
      const first = await f.activate();
      assert.equal(first.status, 'needs_reconciliation');
      assert.ok(!JSON.stringify(first).includes(secret));
      const unknown = await f.job();
      assert.equal(unknown.status, 'needs_reconciliation');
      assert.equal(unknown.details.remoteWritePending, 'install_market_employee');
      const second = await f.activate();
      assert.equal(second.status, 'needs_reconciliation');
      assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
      assert.ok(!JSON.stringify(await f.job()).includes(secret));
      assert.ok(f.calls.every(call => call.url.origin === origin));
    } finally { f.close(); }
  }
});

test('definite upstream rejection blocks activation without retrying or exposing its response body', async () => {
  for (const status of [401, 403, 409, 422]) {
    const f = fixture({ post: () => new Response(`private response ${secret}`, { status }) });
    try {
      const first = await f.activate();
      assert.equal(first.status, 'blocked');
      assert.ok(!JSON.stringify(first).includes(secret));
      await f.activate();
      assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
      assert.ok(!JSON.stringify(await f.job()).includes(secret));
    } finally { f.close(); }
  }
});

test('a missing durable pre-write save prevents the install request', async () => {
  const f = fixture({ repositoryWrapper: repository => ({ ...repository, async updateJob() { return null; } }) });
  try {
    const result = await f.activate();
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'activation_checkpoint_failed');
    assert.equal((await f.activate()).status, 'wait');
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
    assert.ok(await f.job());
  } finally { f.close(); }
});

test('post-write persistence failure stays uncertain and the reserved row prevents another install', async () => {
  let updates = 0;
  const f = fixture({ repositoryWrapper: repository => ({ ...repository, async updateJob(...args) {
    if (++updates > 1) throw new Error(`database unavailable ${secret}`);
    return repository.updateJob(...args);
  } }) });
  try {
    const first = await f.activate();
    assert.equal(first.status, 'needs_reconciliation');
    assert.ok(!JSON.stringify(first).includes(secret));
    assert.equal((await f.activate()).status, 'needs_reconciliation');
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  } finally { f.close(); }
});
