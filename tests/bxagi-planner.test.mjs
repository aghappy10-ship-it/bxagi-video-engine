import test from 'node:test';
import assert from 'node:assert/strict';
import { createBxagiPlanner, bxagiPlannerEvidence, bxagiPlannerCapability } from '../server/bxagi-planner.mjs';

const parentJobId = '9b0bba88-4ea0-49a6-a6df-4eb9cf9debd8';
const otherJobId = 'e56f7c39-4d97-4b2a-8f4a-7ddc5de0e9d2';
const token = 'planner-fixture-token-must-remain-server-only';
const context = { userId: 'tenant-a', nativeUserId: 'tenant-a', subject: 'verified-subject-a', accessToken: token };
const project = { id: 'owned-project', title: '素材测试', productName: '纯棉上衣', description: '制作真实产品素材', facts: ['纯棉面料'], objective: 'views', scene: 'apparel' };
const asset = { id: 'owned-asset', filename: '上衣.png', mimeType: 'image/png', size: 1024, role: 'source' };
const marketEmployee = (marketId, fields) => ({ id: `bxagi:market:${marketId}`, providerId: marketId, marketId, provider: 'bxagi', resourceType: 'installed_employee', installed: true, marketVerified: true, activationState: 'ready', sourceVerified: true, usable: true, ...fields });
const employees = [
  marketEmployee('official-coordinator', { name: '通用协调助理', description: '项目协调', skills: ['planning'] }),
  marketEmployee('official-creative', { name: '素材设计员工', description: '产品素材', skills: ['design'] }),
  marketEmployee('official-buyer', { name: '投放员工', description: '广告计划', skills: ['advertising'] }),
];
const copy = value => structuredClone(value);
const unavailable = () => Object.assign(new Error('Manifest not yet delivered'), { status: 404 });
const unknownWrite = () => Object.assign(new Error('Unknown remote write outcome'), { status: 503, code: 'transport_unavailable', uncertain: true });

async function fixture(options = {}) {
  const catalog = copy(options.employees || employees), calls = options.calls || [], checkpoints = [];
  let state, manifest = options.manifest, failingStage = options.failingStage || null;
  const record = (action, fields = {}) => calls.push({ action, ...fields });
  const remote = {
    async createConversation(input) {
      record('create', { input: copy(input) });
      if (failingStage === 'create_conversation') throw unknownWrite();
      return { startTaskId: 'planner-start-task' };
    },
    async getStartTask(id) { record('start-status', { id }); return { status: 'READY', conversationId: 'planner-conversation' }; },
    async getConversation(id) {
      record('conversation', { id });
      return { id, employee_id: state.coordinatorProviderId, execution_status: 'running' };
    },
    async uploadFile(input) {
      const bytes = new Uint8Array(await input.blob.arrayBuffer());
      record('upload', { conversationId: input.conversationId, directory: input.directory, filename: input.filename, bytes });
      if (failingStage === 'upload_brief') throw unknownWrite();
      return { transportStatus: 200 };
    },
    async sendMessage(conversationId, prompt) {
      record('prompt', { conversationId, prompt });
      if (failingStage === 'send_instruction') throw unknownWrite();
      return { transportStatus: 200 };
    },
    async readManifest(input) {
      record('manifest', { relativePath: input.relativePath });
      if (!manifest) throw unavailable();
      return typeof manifest === 'function' ? manifest(copy(state)) : copy(manifest);
    },
  };
  const planner = createBxagiPlanner({ remote, context: options.context || context });
  state = await planner.createState({ parentJobId, project: options.project || project, assets: options.assets || [asset], employees: catalog, fallbackEmployee: catalog[1] });
  async function advance({ nextEmployees = catalog, nextState = state } = {}) {
    const result = await planner.advance({ state: nextState, employees: nextEmployees, checkpoint: async value => { state = copy(value); checkpoints.push(copy(value)); } });
    state = copy(result.state);
    return result;
  }
  async function until(phase) {
    for (let count = 0; state.phase !== phase && count < 8; count++) await advance();
    assert.equal(state.phase, phase);
    return state;
  }
  const validManifest = (value = state, patch = {}) => ({ version: 1, kind: 'coordination', jobId: value.plannerId, parentJobId: value.parentJobId, inputSignature: value.inputSignature, productionEmployeeId: catalog[1]?.id || catalog[0]?.id, buyingEmployeeId: null, reason: '已有员工的实际岗位适合产品素材', plan: ['读取真实来源文件', '生成真实PNG并保存交付清单'], ...patch });
  return { planner, calls, checkpoints, catalog, advance, until, validManifest, state: () => copy(state), setManifest(value) { manifest = value; }, failAt(value) { failingStage = value; } };
}

test('planner uses an independent task and uploads its brief before sending a prompt; absent output stays unverified', async () => {
  const f = await fixture(), initial = f.state();
  assert.notEqual(initial.plannerId, parentJobId);
  assert.match(initial.plannerId, /^[a-f0-9-]{36}$/i);
  assert.equal(f.calls.length, 0);
  await f.until('waiting_manifest');
  assert.equal(f.calls.find(c => c.action === 'create').input.jobId, initial.plannerId);
  const uploadIndex = f.calls.findIndex(c => c.action === 'upload'), promptIndex = f.calls.findIndex(c => c.action === 'prompt');
  assert.ok(uploadIndex >= 0 && promptIndex > uploadIndex);
  const uploaded = f.calls[uploadIndex];
  assert.equal(uploaded.directory, `bxagi-advertising/${initial.plannerId}/input`);
  assert.equal(uploaded.filename, 'coordination-brief.json');
  const brief = JSON.parse(new TextDecoder().decode(uploaded.bytes));
  assert.equal(brief.jobId, initial.plannerId); assert.equal(brief.parentJobId, parentJobId);
  assert.equal(brief.inputSignature, initial.inputSignature);
  assert.deepEqual(brief.project.facts, project.facts);
  assert.ok(f.calls[promptIndex].prompt.includes(`bxagi-advertising/${initial.plannerId}/output/manifest.json`));
  assert.ok(f.checkpoints.some(s => s.remoteWritePending === 'upload_brief'));
  assert.ok(f.checkpoints.some(s => s.remoteWritePending === 'send_instruction'));
  for (let count = 0; count < 2; count++) {
    const result = await f.advance();
    assert.equal(result.state.phase, 'waiting_manifest'); assert.equal(result.decision, undefined);
    assert.equal(result.state.completedAt, undefined);
    assert.equal(bxagiPlannerEvidence(result.state).decisionVerified, false);
    assert.equal(bxagiPlannerEvidence(result.state).modelVerified, false);
  }
  assert.equal(f.calls.filter(c => c.action === 'prompt').length, 1);
  assert.equal(f.calls.filter(c => c.action === 'create').length, 1);
  assert.ok(f.calls.filter(c => c.action === 'manifest').every(c => c.relativePath === `bxagi-advertising/${initial.plannerId}/output/manifest.json`));
  assert.equal(bxagiPlannerEvidence(f.state()).productionCompleted, undefined);
});

test('verified installed marketplace employees remain selectable by canonical catalog IDs without inventing provider IDs', async () => {
  const marketCatalog = employees.map(employee => ({ ...employee, providerId: null }));
  const f = await fixture({ employees: marketCatalog });
  assert.equal(f.state().coordinatorEmployeeId, marketCatalog[0].id);
  assert.equal(f.state().coordinatorProviderId, null);
  await f.until('waiting_manifest');
  f.setManifest(s => f.validManifest(s, { productionEmployeeId: marketCatalog[1].id, buyingEmployeeId: marketCatalog[2].id }));
  const result = await f.advance();
  assert.equal(result.state.phase, 'ready'); assert.equal(result.decision.productionEmployeeId, marketCatalog[1].id);
  assert.equal(result.decision.buyingEmployeeId, marketCatalog[2].id); assert.equal(result.decision.financialAuthority, false);
  assert.equal(f.calls.find(c => c.action === 'create').input.employee.providerId, null);
  assert.equal(result.decision.modelVerified, false); assert.equal(result.decision.decisionVerified, true);
});

test('historical conversations and unverified, uninstalled or inactive market records never create coordination tasks', async () => {
  for (const patch of [
    { resourceType: 'conversation' },
    { resourceType: 'marketplace_template', installed: false },
    { marketVerified: false },
    { marketId: null },
    { sourceVerified: false },
    { activationState: 'not_installed' },
    { activationState: 'inactive' },
    { activationState: 'starting' },
    { activationState: 'unknown' },
  ]) {
    const calls = []; let f;
    try { f = await fixture({ calls, employees: employees.map(employee => ({ ...employee, ...patch, usable: true })) }); }
    catch (error) { assert.equal(error.status, 409); assert.ok(['bxagi_market_employee_required', 'bxagi_market_employee_activation_required'].includes(error.code), error.code); }
    if (f) {
      assert.equal(f.state().phase, 'rules_fallback', JSON.stringify(patch));
      assert.equal(f.state().snapshot, undefined);
      assert.equal((await f.advance()).decision, null);
    }
    assert.equal(calls.length, 0, JSON.stringify(patch));
  }
  const f = await fixture();
  for (const patch of [{ resourceType: 'conversation' }, { marketVerified: false }, { activationState: 'not_installed' }, { sourceVerified: false }]) {
    const revoked = f.catalog.map(employee => employee.id === employees[1].id ? { ...employee, ...patch, usable: true } : employee);
    assert.throws(() => f.planner.validateDecision(f.state(), f.validManifest(), revoked), e => ['bxagi_planner_invalid_employee', 'bxagi_market_employee_activation_required'].includes(e.code));
  }
  assert.equal(f.calls.length, 0);
});

test('owner, subject, input signature, facts, asset IDs and parent job fences reject altered state before remote calls', async () => {
  const f = await fixture();
  const alterations = [
    s => { s.inputSignature = '0'.repeat(64); },
    s => { s.snapshot.ownerId = 'tenant-b'; },
    s => { s.snapshot.subject = 'subject-b'; },
    s => { s.snapshot.project.facts.push('未经提供的事实'); },
    s => { s.snapshot.assets[0].id = 'foreign-asset'; },
    s => { s.parentJobId = otherJobId; },
    s => { s.snapshot.parentJobId = otherJobId; },
  ];
  for (const change of alterations) {
    const changed = f.state(); change(changed);
    await assert.rejects(f.advance({ nextState: changed }), e => e.status === 409 && e.code === 'bxagi_planner_snapshot_changed');
  }
  await assert.rejects(f.planner.validateState(f.state(), otherJobId), e => e.code === 'bxagi_planner_snapshot_changed');
  assert.equal(f.calls.length, 0);
});

test('unknown conversation, brief upload and prompt writes preserve their checkpoint and never retry', async () => {
  for (const [stage, phase, action] of [['create_conversation', 'created', 'create'], ['upload_brief', 'uploading', 'upload'], ['send_instruction', 'ready_to_send', 'prompt']]) {
    const f = await fixture(); await f.until(phase); f.failAt(stage);
    await assert.rejects(f.advance(), e => e.uncertain === true);
    const pending = f.state(); assert.equal(pending.remoteWritePending, stage);
    assert.equal(f.calls.filter(c => c.action === action).length, 1);
    const writesBefore = f.calls.filter(c => ['create', 'upload', 'prompt'].includes(c.action)).length;
    await assert.rejects(f.advance(), e => e.code === 'bxagi_planner_reconciliation_required' && e.uncertain === true);
    assert.equal(f.calls.filter(c => ['create', 'upload', 'prompt'].includes(c.action)).length, writesBefore);
    assert.equal(f.state().remoteWritePending, stage);
  }
});

test('coordination manifests reject financial authority, foreign selections and incorrect task identity', async () => {
  const f = await fixture(), state = f.state();
  for (const extra of [{ action: 'launch' }, { dailyBudget: 100 }, { decision: { action: 'launch' } }, { accessToken: token }]) {
    assert.throws(() => f.planner.validateDecision(state, f.validManifest(state, extra), f.catalog), e => e.status === 422 && e.code === 'bxagi_planner_authority_refused');
  }
  for (const patch of [{ jobId: otherJobId }, { parentJobId: otherJobId }, { inputSignature: '0'.repeat(64) }, { kind: 'buying' }]) {
    assert.throws(() => f.planner.validateDecision(state, f.validManifest(state, patch), f.catalog), e => e.code === 'bxagi_planner_invalid_manifest');
  }
  assert.throws(() => f.planner.validateDecision(state, f.validManifest(state, { productionEmployeeId: 'bxagi:foreign' }), [...f.catalog, { ...employees[1], id: 'bxagi:foreign' }]), e => e.code === 'bxagi_planner_invalid_employee');
  assert.throws(() => f.planner.validateDecision(state, f.validManifest(state, { plan: Array(7).fill('步骤') }), f.catalog), e => e.code === 'bxagi_planner_invalid_manifest');
  assert.equal(f.calls.length, 0);
});

test('fresh employee availability is enforced at both coordination and output selection', async () => {
  const f = await fixture(); await f.until('starting');
  const withoutCoordinator = f.catalog.map(e => ({ ...e, usable: e.id !== f.state().coordinatorEmployeeId }));
  const callCount = f.calls.length;
  await assert.rejects(f.advance({ nextEmployees: withoutCoordinator }), e => e.code === 'bxagi_planner_employee_unavailable');
  assert.equal(f.calls.length, callCount);
  const unavailableCreative = f.catalog.map(e => ({ ...e, usable: e.id !== employees[1].id }));
  assert.throws(() => f.planner.validateDecision(f.state(), f.validManifest(), unavailableCreative), e => e.code === 'bxagi_market_employee_activation_required');
  const unavailableBuyer = f.catalog.map(e => ({ ...e, usable: e.id !== employees[2].id }));
  assert.throws(() => f.planner.validateDecision(f.state(), f.validManifest(f.state(), { buyingEmployeeId: employees[2].id }), unavailableBuyer), e => e.code === 'bxagi_market_employee_activation_required');
  const empty = await fixture({ employees: [] });
  assert.equal(empty.state().phase, 'rules_fallback'); assert.equal(empty.state().modelVerified, false);
  assert.equal((await empty.advance()).decision, null); assert.equal(empty.calls.length, 0);
});

test('a saved ready decision is revalidated against current identity, signature, parent and employee availability', async () => {
  const f = await fixture(); await f.until('waiting_manifest'); f.setManifest(s => f.validManifest(s));
  const ready = (await f.advance()).state, callsBefore = f.calls.length;
  const valid = await f.planner.validateReady(ready, f.catalog, parentJobId);
  assert.equal(valid.productionEmployeeId, employees[1].id); assert.equal(valid.financialAuthority, false);
  await assert.rejects(f.planner.validateReady(ready, f.catalog, otherJobId), e => e.code === 'bxagi_planner_snapshot_changed');
  for (const change of [s => { s.snapshot.ownerId = 'tenant-b'; }, s => { s.snapshot.subject = 'other-subject'; }, s => { s.snapshot.assets[0].size++; }, s => { s.inputSignature = '0'.repeat(64); }]) {
    const altered = copy(ready); change(altered);
    await assert.rejects(f.planner.validateReady(altered, f.catalog, parentJobId), e => e.code === 'bxagi_planner_snapshot_changed');
    await assert.rejects(f.advance({ nextState: altered }), e => e.code === 'bxagi_planner_snapshot_changed');
  }
  const unavailableCreative = f.catalog.map(e => ({ ...e, usable: e.id !== employees[1].id }));
  await assert.rejects(f.planner.validateReady(ready, unavailableCreative, parentJobId), e => e.code === 'bxagi_market_employee_activation_required');
  assert.equal(f.calls.length, callsBefore);
});

test('bounded metadata excludes storage and credential fields, and public decision evidence does not claim model verification', async () => {
  const manyEmployees = Array.from({ length: 25 }, (_, index) => marketEmployee(`official-candidate-${index}`, { name: '通用协调助理', description: '项目协调', skills: ['planning'], providerId: null, accessToken: token, sessionApiKey: token }));
  const manyAssets = Array.from({ length: 25 }, (_, index) => ({ ...asset, id: `asset-${index}`, objectKey: `private/objects/${index}`, accessToken: token, sessionApiKey: token }));
  const f = await fixture({ employees: manyEmployees, assets: manyAssets, project: { ...project, credentials: { accessToken: token }, objectKey: 'private/project' } });
  const state = f.state(), serialized = JSON.stringify(state);
  assert.equal(state.snapshot.candidates.length, 20); assert.equal(state.snapshot.assets.length, 20);
  assert.equal(state.snapshot.ownerId, context.userId); assert.equal(state.snapshot.subject, context.subject);
  assert.equal(state.snapshot.parentJobId, parentJobId); assert.match(state.inputSignature, /^[a-f0-9]{64}$/);
  assert.ok(new TextEncoder().encode(JSON.stringify(state.snapshot)).length <= 64 * 1024);
  assert.ok(!serialized.includes(token)); assert.ok(!serialized.includes('objectKey')); assert.ok(!serialized.includes('sessionApiKey'));
  const manifest = f.validManifest(state, { productionEmployeeId: manyEmployees[1].id, reason: `岗位适合 ${token}`, plan: [`生成PNG ${token}`] });
  const decision = f.planner.validateDecision(state, manifest, f.catalog);
  assert.ok(!JSON.stringify(decision).includes(token)); assert.ok(decision.reason.includes('[redacted]'));
  const evidence = bxagiPlannerEvidence({ ...state, phase: 'ready', decision });
  assert.equal(evidence.decisionVerified, true); assert.equal(evidence.modelVerified, false);
  assert.equal(evidence.snapshot, undefined); assert.equal(evidence.financialAuthority, undefined);
  assert.equal(bxagiPlannerCapability.directCompletionApiVerified, false);
});
