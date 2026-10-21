import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createBxagiButlerCoordinator, bxagiButlerCoordinationEvidence } from '../server/bxagi-butler-coordinator.mjs';
import { createBxagiOrchestrator, scoreBxagiMarketEmployee } from '../server/bxagi-orchestrator.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';

const context = { userId: 'butler-owner', nativeUserId: 'butler-owner', subject: 'butler-subject', accessToken: 'private-butler-token' };
const parentJobId = '3b136d6e-2d81-460b-a089-f415313ec608';
const conversationId = 'e411073e977d47149aa2cff96914faed7';
const employee = (marketId, fields = {}) => ({ id: `bxagi:market:${marketId}`, marketId, providerId: marketId, provider: 'bxagi', resourceType: 'installed_employee', installed: true, marketVerified: true, sourceVerified: true, usable: true, activationState: 'ready', conversationId: `hired-${marketId}`, name: '素材设计员工', skills: ['image-generation'], ...fields });
const catalog = [employee('production-a'), employee('production-b'), employee('buyer', { name: '广告投放专家', skills: ['paid-media-buying'] })];
const project = { id: 'source-project', title: '产品素材', scene: 'general', objective: 'views' };
const assets = [{ id: 'source-asset', mimeType: 'image/png', size: 1024 }];
const clone = value => structuredClone(value);
const message = (eventId, source, text, timestamp) => ({ id: eventId, kind: 'MessageEvent', source, timestamp, llm_message: { role: source === 'agent' ? 'assistant' : 'user', content: [{ type: 'text', text }] } });

async function fixture(options = {}) {
  const calls = [], checkpoints = [], rows = [], employees = clone(options.employees || catalog);
  let state, prompt = '', dispatchError = null, checkpointError = null, ready = true, conversation = { id: conversationId, employee_id: 'general_assistant', created_by_user_id: context.subject, parent_conversation_id: null };
  const bootstrap = { async inspect() { calls.push('inspect'); return { status: ready ? 'ready' : 'missing', enabled: true, ownershipVerified: true, templateId: 'general_assistant', conversationId }; } };
  const remote = { async getConversation(id) { calls.push('conversation'); assert.equal(id, conversationId); return clone(conversation); }, async getEvents() { calls.push('events'); return clone(rows); } };
  const butler = {
    async inspectCapabilities() { calls.push('flags'); return { enabled: true }; },
    async dispatchCoordination(input) { calls.push('dispatch'); assert.equal(state.remoteWritePending, 'dispatch_official_butler'); prompt = input.text; if (dispatchError) throw dispatchError; return { accepted: true, clientMessageId: input.clientMessageId, conversationId: options.receiptConversationId || conversationId, outcomeUnknown: false }; },
  };
  const api = createBxagiButlerCoordinator({ context, remote, butler, bootstrap, scoreEmployee: scoreBxagiMarketEmployee });
  rows.push(message('baseline-agent', 'agent', '旧任务回复', '2026-10-15T00:00:00Z'));
  state = await api.createState({ parentJobId, project: options.project || project, assets: options.assets || assets, employees });
  const advance = async (next = {}) => { const result = await api.advance({ state: next.state || state, employees: next.employees || employees, checkpoint: async value => { if (checkpointError && value.dispatchAccepted === true) throw checkpointError; state = clone(value); checkpoints.push(clone(value)); } }); state = clone(result.state); return result; };
  const valid = (patch = {}) => ({ requestId: state.requestId, inputSignature: state.inputSignature, productionEmployeeId: state.snapshot.candidates[0].id, reason: '岗位与素材制作目标相符', plan: ['读取用户真实素材', '产出优化图片及交付清单'], ...patch });
  const reply = (patch = {}, overrides = {}) => {
    rows.unshift(message('user-current', 'user', prompt, '2026-10-15T08:00:00Z'));
    rows.unshift({ ...message('agent-current', 'agent', JSON.stringify(valid(patch)), '2026-10-15T08:00:01Z'), ...overrides });
  };
  return { api, remote, butler, bootstrap, calls, checkpoints, rows, employees, advance, valid, reply, state: () => clone(state), prompt: () => prompt, failDispatch(value) { dispatchError = value; }, failAcceptedCheckpoint(value) { checkpointError = value; }, setReady(value) { ready = value; }, setConversation(value) { conversation = { ...conversation, ...value }; } };
}

test('official butler sends one bounded request after its durable checkpoint, consumes a fresh owned reply and retains separate advice evidence', async () => {
  const f = await fixture(); await f.advance();
  assert.equal(f.calls.filter(value => value === 'dispatch').length, 1); assert.ok(f.prompt().length <= 500); assert.match(f.prompt(), /不生产\/安装/); assert.ok(f.prompt().includes(f.state().inputSignature));
  assert.ok(f.prompt().includes('"media":["image/png"]')); assert.ok(f.prompt().includes('"assetCount":1'));
  assert.ok(f.state().snapshot.candidates.every(candidate => candidate.id !== catalog[2].id));
  assert.equal(f.state().phase, 'waiting_reply'); assert.equal((await f.advance()).decision, undefined);
  f.reply(); const done = await f.advance(); assert.equal(done.state.phase, 'ready'); assert.equal(done.decision.financialAuthority, false); assert.equal(done.decision.productionExecutedByButler, false);
  assert.equal(done.state.userEventId, 'user-current'); assert.equal(done.state.replyEventId, 'agent-current');
  assert.equal((await f.api.validateReady(done.state, f.employees, parentJobId)).productionEmployeeId, done.decision.productionEmployeeId);
  assert.equal(bxagiButlerCoordinationEvidence(done.state).decisionVerified, true); assert.equal(bxagiButlerCoordinationEvidence(done.state).modelVerified, false);
  await f.advance(); assert.equal(f.calls.filter(value => value === 'dispatch').length, 1); assert.ok(!JSON.stringify(done).includes(context.accessToken));
});

test('the actual video specialist ID and all four licensed-resource input types fit the official 500-character request', async () => {
  const actualId = 'marketing_video_optimization_specialist';
  const f = await fixture({ project: { ...project, title: 'BXAGI 智能调度实测' },
    employees: [employee(actualId, { name: '视频优化专家', skills: ['video-optimization'] })],
    assets: ['text/plain','application/octet-stream','text/plain','text/plain'].map((mimeType, index) => ({ id: `actual-source-${index}`, mimeType, size: 1000 })) });
  await f.advance(); assert.ok(f.prompt().length <= 500, `actual prompt length ${f.prompt().length}`);
  assert.ok(f.prompt().includes(`"id":"bxagi:market:${actualId}"`)); assert.ok(f.prompt().includes('"assetCount":4'));
  assert.ok(f.prompt().includes('"media":["text/plain","application/octet-stream"]'));
  assert.equal(f.state().snapshot.assets.length, 4); assert.equal(f.state().snapshot.candidates.length, 1);
});

test('diagnostics inspect only the expected owned main conversation and current request events without changing or dispatching state', async () => {
  const f = await fixture(); await f.advance(); f.reply(); const saved = f.state(), dispatches = f.calls.filter(value => value === 'dispatch').length, checkpoints = f.checkpoints.length;
  // Another user turn and its reply are newer than our task and must not leak.
  f.rows.unshift(message('foreign-turn-user', 'user', 'unrelated private user message', '2026-10-15T08:01:00Z'));
  f.rows.unshift(message('foreign-turn-agent', 'agent', 'unrelated private agent response', '2026-10-15T08:01:01Z'));
  const result = await f.api.diagnose({ state: saved, parentJobId });
  assert.equal(result.readOnly, true); assert.equal(result.remoteWrites, false); assert.equal(result.expectedConversationId, conversationId);
  assert.equal(result.exactUserBoundary, true); assert.equal(result.latestNewUser.eventId, 'user-current'); assert.equal(result.latestNewAssistant.eventId, 'agent-current'); assert.equal(result.latestNewAssistant.matchesRequest, true);
  assert.ok(!JSON.stringify(result).includes('unrelated private')); assert.deepEqual(f.state(), saved); assert.equal(f.checkpoints.length, checkpoints); assert.equal(f.calls.filter(value => value === 'dispatch').length, dispatches);
});

test('diagnostics redact credentials and never expose unmatched old or foreign replies without a current user boundary', async () => {
  const f = await fixture(); await f.advance(); f.reply();
  f.rows[0].llm_message.content[0].text = `API_KEY=never-leak-a password="never-leak-b" Bearer never-leak-c https://secret.example/never-leak-d ${context.accessToken} ` + 'x'.repeat(1000);
  const result = await f.api.diagnose({ state: f.state(), parentJobId });
  assert.equal(result.latestNewAssistant.eventId, 'agent-current'); assert.ok(result.latestNewAssistant.text.length <= 600); assert.ok(!JSON.stringify(result).includes('never-leak')); assert.ok(!JSON.stringify(result).includes(context.accessToken));
  f.rows.splice(1, 1); const missing = await f.api.diagnose({ state: f.state() }); assert.equal(missing.exactUserBoundary, false); assert.equal(missing.latestNewUser, null); assert.equal(missing.latestNewAssistant, null);
  f.setConversation({ created_by_user_id: 'foreign-owner' }); await assert.rejects(f.api.diagnose({ state: f.state() }), { code: 'bxagi_butler_owner_mismatch' });
});

test('absent or mismatched current user boundary and stale replies never produce a decision', async () => {
  for (const variant of ['no-user', 'wrong-user', 'old-agent-id', 'wrong-request', 'wrong-signature', 'tool', 'before-user']) {
    const f = await fixture(); await f.advance(); f.reply();
    if (variant === 'no-user') f.rows.splice(1, 1);
    if (variant === 'wrong-user') f.rows[1].llm_message.content[0].text += ' changed';
    if (variant === 'old-agent-id') { f.rows.pop(); f.rows[0].id = 'baseline-agent'; }
    if (variant === 'wrong-request') f.rows[0].llm_message.content[0].text = JSON.stringify(f.valid({ requestId: 'f'.repeat(32) }));
    if (variant === 'wrong-signature') f.rows[0].llm_message.content[0].text = JSON.stringify(f.valid({ inputSignature: 'e'.repeat(64) }));
    if (variant === 'tool') f.rows[0].source = 'tool';
    if (variant === 'before-user') [f.rows[0], f.rows[1]] = [f.rows[1], f.rows[0]];
    assert.equal((await f.advance()).decision, undefined, variant); assert.notEqual(f.state().phase, 'ready', variant); assert.equal(f.calls.filter(value => value === 'dispatch').length, 1);
  }
});

test('current reply order and nonce remain valid with same-second timestamps or upstream clock rollback', async () => {
  for (const timestamp of ['2026-10-15T08:00:00Z', '2026-10-15T07:59:59Z']) {
    const f = await fixture(); await f.advance(); f.reply({}, { timestamp }); const result = await f.advance();
    assert.equal(result.state.phase, 'ready'); assert.equal(result.state.userEventId, 'user-current'); assert.equal(result.state.replyEventId, 'agent-current');
  }
});

test('an accepted dispatch followed by a 409 or 422 checkpoint failure remains unknown and cannot resend', async () => {
  for (const status of [409, 422]) {
    const f = await fixture(); f.failAcceptedCheckpoint(Object.assign(new Error('storage checkpoint rejected'), { status, code: 'checkpoint_failed' }));
    await assert.rejects(f.advance(), failure => failure.status === status && failure.uncertain === true && failure.outcomeUnknown === true);
    assert.equal(f.state().remoteWritePending, 'dispatch_official_butler'); assert.equal(f.state().phase, 'created');
    f.failAcceptedCheckpoint(null); await assert.rejects(f.advance(), { code: 'bxagi_butler_reconciliation_required' });
    assert.equal(f.calls.filter(value => value === 'dispatch').length, 1);
  }
});

test('foreign coordinator owner, wrong employee or changed main conversation prevents any dispatch', async () => {
  for (const patch of [{ created_by_user_id: 'other-subject' }, { employee_id: 'different-worker' }, { id: 'different-conversation' }, { parent_conversation_id: 'parent' }]) {
    const f = await fixture(); f.setConversation(patch); await assert.rejects(f.advance(), { code: 'bxagi_butler_owner_mismatch' }); assert.equal(f.calls.includes('dispatch'), false);
  }
  const f = await fixture(); f.setReady(false); await assert.rejects(f.advance(), { code: 'bxagi_butler_not_ready' }); assert.equal(f.calls.includes('dispatch'), false);
});

test('input, parent, account and baseline mutations are rejected before further reads or writes', async () => {
  for (const mutate of [s => s.parentJobId = crypto.randomUUID(), s => s.snapshot.subject = 'foreign', s => s.snapshot.ownerId = 'foreign', s => s.snapshot.assets[0].size++, s => s.snapshot.baselineEventIds = [], s => s.snapshot.candidates[0].id = 'bxagi:market:foreign', s => s.clientMessageId = 'a'.repeat(32), s => s.conversationId = crypto.randomUUID()]) {
    const f = await fixture(), state = f.state(), calls = f.calls.length; mutate(state); await assert.rejects(f.advance({ state }), { code: 'bxagi_butler_snapshot_changed' }); assert.equal(f.calls.length, calls);
  }
});

test('unknown or mismatched accepted dispatches preserve pending state and never replay', async () => {
  for (const mismatch of [false, true]) {
    const f = await fixture(mismatch ? { receiptConversationId: 'a'.repeat(32) } : {});
    if (!mismatch) f.failDispatch(Object.assign(new Error('network failed'), { status: 502, uncertain: true, outcomeUnknown: true }));
    await assert.rejects(f.advance(), value => value.uncertain === true); assert.equal(f.state().remoteWritePending, 'dispatch_official_butler');
    if (mismatch) { assert.equal(f.state().dispatchAcceptedObserved, true); assert.equal(f.state().dispatchReceiptConversationId, 'a'.repeat(32)); assert.equal(f.state().dispatchReceiptClientMessageId, f.state().clientMessageId); assert.equal(f.state().dispatchAccepted, undefined); }
    await assert.rejects(f.advance(), { code: 'bxagi_butler_reconciliation_required' }); assert.equal(f.calls.filter(value => value === 'dispatch').length, 1);
  }
});

test('explicit refusal remains terminal without a second dispatch', async () => {
  const f = await fixture(); f.failDispatch(Object.assign(new Error('refused'), { status: 403, uncertain: false, outcomeUnknown: false }));
  await assert.rejects(f.advance()); assert.equal(f.state().remoteWritePending, null); assert.equal(f.state().dispatchRefused, true);
  await assert.rejects(f.advance(), { code: 'bxagi_butler_dispatch_refused' }); assert.equal(f.calls.filter(value => value === 'dispatch').length, 1);
});

test('unverified or nonproduction market candidates cannot be sent or selected', async () => {
  for (const patch of [{ resourceType: 'conversation' }, { resourceType: 'marketplace_template' }, { usable: false }, { sourceVerified: false }, { providerId: null }, { activationState: 'starting' }]) {
    await assert.rejects(fixture({ employees: catalog.map(value => ({ ...value, ...patch })) }), { code: 'bxagi_butler_market_candidates_required' });
  }
  const f = await fixture(); await f.advance(); f.reply({ productionEmployeeId: catalog[2].id }); await assert.rejects(f.advance(), { code: 'bxagi_butler_employee_invalid' });
});

test('changed instance, source conversation or current availability rejects advice before production', async () => {
  for (const patch of [{ providerId: 'different-instance' }, { conversationId: 'different-source' }, { usable: false }, { name: '广告投放专家', skills: ['paid-media-buying'] }]) {
    const f = await fixture(); await f.advance(); f.reply(); const employees = f.employees.map(value => value.id === f.valid().productionEmployeeId ? { ...value, ...patch } : value);
    await assert.rejects(f.advance({ employees }), { code: 'bxagi_butler_employee_invalid' });
  }
});

test('strict JSON rejects extra authority, oversized plans, malformed content and duplicate user echoes', async () => {
  for (const patch of [{ budget: 100 }, { buyingEmployeeId: catalog[2].id }, { plan: [] }, { plan: Array(7).fill('step') }, { reason: 'x'.repeat(121) }]) {
    const f = await fixture(); await f.advance(); f.reply(patch); await assert.rejects(f.advance(), { code: 'bxagi_butler_reply_invalid' });
  }
  const f = await fixture(); await f.advance(); f.reply(); f.rows[0].llm_message.content[0].text += '\n执行成功'; await assert.rejects(f.advance(), { code: 'bxagi_butler_reply_invalid' });
  const duplicate = await fixture(); await duplicate.advance(); duplicate.reply(); duplicate.rows.push({ ...duplicate.rows[1], id: 'second-user' }); await assert.rejects(duplicate.advance(), { code: 'bxagi_butler_event_ambiguous' });
});

function database() {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(value => value.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return { sqlite, prepare(sql) { const statement = sqlite.prepare(sql); return { bind(...args) { return { async first() { return statement.get(...args) ?? null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } }; } }; } };
}
function bucket() { const values = new Map(); return { async put(key, value) { const bytes = new Uint8Array(await new Response(value).arrayBuffer()); values.set(key, bytes); return { size: bytes.length }; }, async get(key) { const bytes = values.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes]).stream(), async arrayBuffer() { return bytes.slice().buffer; } } : null; } }; }

test('orchestrator gives official butler priority, keeps saved mode after flags change and separately executes the chosen real market worker', async () => {
  const f = await fixture(), db = database(), store = bucket(), repo = createPlatformRepository(db), env = { BXAGI_BUTLER_ENABLED: true, BXAGI_PLANNER_ENABLED: true }, productions = [], inputs = new Map();
  const source = new TextEncoder().encode('用户提供的真实素材说明'); await store.put('source', source);
  const ownedProject = await repo.createProject(context.nativeUserId, { ...project, title: '大管家调度验证', facts: ['用户事实'] });
  const asset = await repo.createAsset(context.nativeUserId, { projectId: ownedProject.id, filename: 'source.txt', mimeType: 'text/plain', size: source.length, objectKey: 'source' });
  let actualState, prompt = '';
  const events = [];
  const remote = { ...f.remote,
    async listEmployees() { return clone(catalog); }, async getEvents() { return clone(events); },
    async createConversation(input) { productions.push(input); return { startTaskId: 'real-start-task' }; },
    async getStartTask() { return { status: 'READY', conversationId: 'actual-production-conversation' }; },
    async getConversation(id) { return id === conversationId ? f.remote.getConversation(id) : { id, employee_id: productions[0].employee.providerId, created_by_user_id: context.subject, agent_type: 'CodeActAgent' }; },
    async ensureRuntime() { return { status: 'ready' }; },
    async uploadFile(input) { inputs.set(input.filename, await input.blob.text()); },
    async sendMessage(_id, text) { assert.match(text, /协调建议只是待审数据/); return { messageAcknowledged: true, eventId: 'production-ack', transport: 'bxagi_ws' }; },
    async readManifest({ conversation }) { assert.equal(conversation.id, 'actual-production-conversation'); const brief = JSON.parse(inputs.get('brief.json')); return { version: 1, kind: 'production', jobId: brief.jobId, creatives: [{ path: `bxagi-advertising/${brief.jobId}/output/result.txt`, filename: 'result.txt', mimeType: 'text/plain', title: '员工实际成品', format: 'square', sourceAssetIds: [asset.id], factsUsed: ['用户事实'] }] }; },
    async readArtifact() { return new Response('员工实际成品：用户事实'); },
  };
  const butler = { async inspectCapabilities() { return { enabled: true }; }, async dispatchCoordination(input) { prompt = input.text; const job = await repo.getJob(context.nativeUserId, actualState.id); assert.equal(job.details.remoteWritePending, 'coordination:dispatch_official_butler'); return { accepted: true, clientMessageId: input.clientMessageId, conversationId, outcomeUnknown: false }; } };
  const workflow = () => createBxagiOrchestrator({ repository: repo, bucket: store, env, context, workforce: remote, butler, butlerBootstrap: f.bootstrap });
  try {
    const submitted = await workflow().submitProduction(ownedProject); actualState = submitted.job;
    let result = await workflow().syncJob(submitted.job.id); assert.equal(result.job.details.coordination.mode, 'official_butler');
    env.BXAGI_BUTLER_ENABLED = false; env.BXAGI_PLANNER_ENABLED = false;
    result = await workflow().syncJob(submitted.job.id); assert.equal(result.job.details.coordination.phase, 'waiting_reply'); assert.equal(productions.length, 0);
    const coordination = result.job.details.coordination, selected = coordination.snapshot.candidates.at(-1).id;
    events.push(message('fresh-assistant', 'agent', JSON.stringify({ requestId: coordination.requestId, inputSignature: coordination.inputSignature, productionEmployeeId: selected, reason: '实际岗位匹配素材任务', plan: ['优化原素材并交付清单'] }), '2026-10-15T12:00:01Z'), message('fresh-user', 'user', prompt, '2026-10-15T12:00:00Z'));
    result = await workflow().syncJob(submitted.job.id); assert.equal(result.job.employeeId, selected); assert.ok(result.job.details.coordination.routingAppliedAt); assert.equal(productions.length, 0);
    for (let step = 0; step < 15 && result.job.status !== 'completed'; step++) result = await workflow().syncJob(submitted.job.id);
    assert.equal(result.job.status, 'completed'); assert.equal(productions.length, 1); assert.equal(productions[0].employee.id, selected); assert.equal(productions[0].jobId, submitted.job.id); assert.equal(result.job.details.messageAcknowledged, true); assert.equal(result.job.details.coordination.replyEventId, 'fresh-assistant');
    const creatives = await repo.listCreatives(context.nativeUserId, ownedProject.id); assert.equal(creatives.length, 1); assert.ok(await store.get(creatives[0].objectKey));
    assert.equal((await repo.getProject(context.nativeUserId, ownedProject.id)).assignment.routingMode, 'official_butler');
    await workflow().syncJob(submitted.job.id); assert.equal(productions.length, 1);
  } finally { db.sqlite.close(); }
});
