import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createBxagiButlerBootstrap, bxagiButlerBootstrapProof } from '../server/bxagi-butler-bootstrap.mjs';

const token = 'butler-bootstrap-fixture-credential';
const context = { userId: 'owner', subject: 'bxagi-owner', accessToken: token };
const rootId = '12345678-1234-4234-8234-123456789012';
const oldRootId = '22345678-1234-4234-8234-123456789012';
const expiry = () => new Date(Date.now() + 600000).toISOString();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const active = () => ({ employee_id: 'general_assistant', status: 'active', usable: true, conversation_exists: true, conversation_id: rootId });
const reviewedReflection = () => ({ name: '每周反思周报', type: 'weekly', config: { weekly_day: 6, weekly_time: '20:00', drift_minutes: 15 }, message: `【每周反思周报】现在是我的定期反思时间。请以第一人称完成本周反思周报，并把结论固化进记忆：
1. 回顾本周工作：浏览本周的对话与工作产出，总结我做了什么、关键结果是什么；
2. 盘点被驳回/纠正：哪些动作或回复被用户驳回、纠正或返工，正确做法是什么；
3. 核对记忆中的教训：逐条检查 MEMORY.md 与知识图谱里已记录的经验教训，本周是否真的遵守了，哪些还在重犯；
4. 识别反复出现的问题模式：同类问题是否重复出现，根因是什么，我打算怎么改；
5. 固化反思结论：把新的教训与改进规则写入 MEMORY.md 和知识图谱，过时或已验证无效的结论予以更新或清理。
最后输出一份简短的反思周报作为本轮回复（本周完成 / 被纠正事项 / 教训核对 / 改进计划 四节）。` });

function db() {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return { sqlite, prepare(sql) { const stmt = sqlite.prepare(sql); return { bind(...args) { return { async first() { return stmt.get(...args) ?? null; }, async all() { return { results: stmt.all(...args) }; }, async run() { return { meta: { changes: Number(stmt.run(...args).changes) } }; } }; } }; } };
}
function fixture(options = {}) {
  const DB = db(), repository = createPlatformRepository(DB), calls = [];
  let installed = options.installed || [], postCount = 0, mineCount = 0;
  const root = { id: rootId, employee_id: 'general_assistant', created_by_user_id: context.subject, parent_conversation_id: null, node_id: 'owned-node', agent_type: 'AgiAgent', participants: [{ type: 'agent', is_primary: true, node_id: 'owned-node' }], ...options.root };
  const fetcher = async (url, init) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, search: parsed.search, method: init.method });
    assert.equal(parsed.origin, 'https://bxagi.xinlx.com'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, `Bearer ${token}`);
    if (parsed.pathname === '/api/v1/feature-flags') return json(options.flags || { butler_mode: true, general_mode: true });
    if (parsed.pathname === '/api/v1/employees/templates') return json(options.templates || [{ id: 'general_assistant', name: '通用助理', category: '通用', has_subs: false }]);
    if (parsed.pathname === '/api/v1/employees/mine') { mineCount++; return json({ items: options.mineAt ? options.mineAt(mineCount, installed) : installed }); }
    if (parsed.pathname === '/api/nodes') { assert.equal(parsed.search, ''); return json({ nodes: options.nodes || [{ node_id: 'owned-node', status: 'online', gateway_connected: true }] }); }
    if (parsed.pathname === '/locales/zh-CN/translation.json') return json(options.translations || { [bxagiButlerBootstrapProof.badgeKey]: bxagiButlerBootstrapProof.badge, 'GENERAL_CHAT$HIRE_BUTTON': '免费雇佣通用助理' });
    if (parsed.pathname === '/api/v1/employees/templates/general_assistant/schedules') return json(options.schedules || []);
    if (parsed.pathname === '/api/v1/app-conversations') { assert.equal(parsed.searchParams.get('ids'), rootId); return json(options.rootResponse || [root]); }
    assert.equal(parsed.pathname, '/api/v1/employees/install'); assert.equal(init.method, 'POST'); postCount++;
    const job = await repository.getBxagiButlerBootstrap(context.userId, context.subject);
    assert.equal(job.status, 'installing'); assert.equal(job.details.remoteWritePending, 'install_builtin_general_assistant'); assert.ok(job.details.operationId); assert.ok(job.details.attemptedAt);
    assert.deepEqual(JSON.parse(init.body), { template_id: 'general_assistant', node_id: 'owned-node', department: '通用', locale: 'zh' });
    if (options.post) return options.post({ job, repository, setInstalled: value => { installed = value; } });
    installed = [active()]; return json({ main_conversation_id: rootId });
  };
  const api = createBxagiButlerBootstrap({ repository: options.repoWrapper ? options.repoWrapper(repository) : repository, context, fetcher, timeoutMs: options.timeoutMs });
  return { DB, repository, api, calls, postCount: () => postCount, job: () => repository.getBxagiButlerBootstrap(context.userId, context.subject), close: () => DB.sqlite.close() };
}

test('read-only inspection establishes fixed built-in free contract without installing', async () => {
  const f = fixture(); try { const r = await f.api.inspect(); assert.equal(r.status, 'available'); assert.equal(r.freeBasis, 'official_builtin'); assert.equal(r.ownedOnlineNodeCount, 1); assert.equal(r.ownershipVerified, false); assert.equal(f.postCount(), 0); assert.equal(await f.job(), null); assert.ok(!JSON.stringify(r).includes(token)); } finally { f.close(); }
});
test('general chat visibility is independent from the official butler and built-in market initialization', async () => {
  const f = fixture({ flags: { butler_mode: true, general_mode: false } });
  try {
    const state = await f.api.inspect();
    assert.equal(state.enabled, true); assert.equal(state.generalChatEnabled, false);
    assert.equal(state.status, 'available'); assert.equal(state.canInitialize, true); assert.equal(state.freeBasis, 'official_builtin');
    const ready = await f.api.ensure({ authorizationExpiresAt: expiry() });
    assert.equal(ready.status, 'ready'); assert.equal(ready.generalChatEnabled, false); assert.equal(ready.ownershipVerified, true); assert.equal(f.postCount(), 1);
  } finally { f.close(); }
  for (const flags of [{ butler_mode: false, general_mode: true }, { butler_mode: false, general_mode: false }, { general_mode: true }]) {
    const blocked = fixture({ flags });
    try { assert.equal((await blocked.api.ensure({ authorizationExpiresAt: expiry() })).status, 'blocked'); assert.equal(blocked.postCount(), 0); } finally { blocked.close(); }
  }
});
test('schedule diagnostics expose only bounded safe labels and never authorize automatic schedules', async () => {
  const f = fixture({ schedules: [
    { id: 'daily-maintenance', name: '每日例行任务', type: 'daily', config: { cron_hour: 8, prompt: 'private-instruction' }, instruction: 'private-body' },
    { id: 'interval-disabled', name: `secret=hidden-value ${token} https://private.example/task`, type: 'interval', enabled: false, credentials: 'private-credentials' },
  ] });
  try {
    const state = await f.api.inspect();
    assert.equal(state.status, 'blocked'); assert.equal(state.reason, 'butler_bootstrap_schedules_present');
    assert.equal(state.scheduleCount, 2); assert.equal(state.canInitialize, false); assert.equal(state.canRepair, false);
    assert.deepEqual(state.schedules[0], { id: 'daily-maintenance', name: '每日例行任务', type: 'daily', enabled: null });
    assert.equal(state.schedules[1].enabled, false);
    assert.deepEqual(Object.keys(state.schedules[1]).sort(), ['enabled','id','name','type']);
    for (const forbidden of ['private-instruction','private-body','private-credentials','hidden-value',token,'https://private.example']) assert.ok(!JSON.stringify(state).includes(forbidden));
    assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'blocked'); assert.equal(f.postCount(), 0);
  } finally { f.close(); }
});
test('private schedule policy is explicit, redacted, bounded and never included in public readiness or ensure', async () => {
  const f = fixture({ schedules: [{ name: '每周反思周报', type: 'weekly', config: {
    prompt: `总结本周工作 ${token} Bearer private-bearer api_key=private-key 密码：private-password https://private.example/report ftp://private.example/data ${'内容'.repeat(700)}`,
    message: 'another-instruction', cron_hour: 9, cron_day_of_week: 'mon', timezone: 'Asia/Shanghai', interval: { secret: 'nested-secret' }, credentials: 'private-credentials', arbitrary: 'private-extra',
  } }] });
  try {
    const publicState = await f.api.inspect();
    assert.equal(publicState.schedulePolicyDiagnostics, undefined);
    assert.equal((await f.api.inspect({ includeSchedulePolicy: 'true' })).schedulePolicyDiagnostics, undefined);
    const privateState = await f.api.inspect({ includeSchedulePolicy: true });
    assert.equal(privateState.reason, 'butler_bootstrap_schedules_present');
    const policy = privateState.schedulePolicyDiagnostics[0];
    assert.ok(policy.configKeys.includes('prompt')); assert.ok(policy.configKeys.includes('credentials'));
    assert.deepEqual(policy.timing, { cron_day_of_week: 'mon', cron_hour: 9, timezone: 'Asia/Shanghai' });
    assert.ok(policy.instructions[0].text.startsWith('总结本周工作'));
    assert.ok(policy.instructions.reduce((sum, row) => sum + row.text.length, 0) <= 1000);
    for (const forbidden of [token, 'private-bearer', 'private-key', 'private-password', 'private.example', 'private-credentials', 'private-extra', 'nested-secret']) assert.ok(!JSON.stringify(privateState).includes(forbidden), forbidden);
    const ensured = await f.api.ensure({ authorizationExpiresAt: expiry(), includeSchedulePolicy: true });
    assert.equal(ensured.schedulePolicyDiagnostics, undefined); assert.equal(ensured.reason, 'butler_bootstrap_schedules_present');
    assert.ok(!JSON.stringify(publicState).includes('总结本周工作')); assert.equal(f.postCount(), 0);
  } finally { f.close(); }
});
test('only the reviewed fixed built-in weekly reflection permits initialization without claiming execution', async () => {
  const f = fixture({ schedules: [reviewedReflection()] });
  try {
    const state = await f.api.inspect({ includeSchedulePolicy: true });
    assert.equal(state.status, 'available'); assert.equal(state.standardBuiltinReflection, true); assert.equal(state.canInitialize, true);
    assert.deepEqual(state.schedulePolicyDiagnostics[0].timing, { weekly_day: 6, weekly_time: '20:00', drift_minutes: 15 });
    assert.equal(state.liveVerified, false); assert.equal(state.schedules[0].enabled, null);
    const ready = await f.api.ensure({ authorizationExpiresAt: expiry() });
    assert.equal(ready.status, 'ready'); assert.equal(ready.standardBuiltinReflection, true); assert.equal(ready.schedulePolicyDiagnostics, undefined); assert.equal(f.postCount(), 1);
    assert.ok(f.calls.every(call => !call.path.startsWith('/api/v1/scheduled-tasks')));
  } finally { f.close(); }
});
test('observed reflection kind and Friday schedule initialize, while other kinds fail closed', async () => {
  for (const taskKind of ['reflection',' reflection','reflection ','message','unverified_kind',null]) {
    const schedule = { ...reviewedReflection(), task_kind: taskKind, config: { weekly_day: 'friday', weekly_time: '18:00', drift_minutes: 30 } };
    const f = fixture({ schedules: [schedule] });
    try {
      const state = await f.api.inspect({ includeSchedulePolicy: true });
      assert.equal(state.schedulePolicyChecks.knownRowFields, true); assert.equal(state.schedulePolicyChecks.taskKind, taskKind === 'reflection');
      const outcome = await f.api.ensure({ authorizationExpiresAt: expiry() });
      assert.equal(outcome.status, taskKind === 'reflection' ? 'ready' : 'blocked'); assert.equal(f.postCount(), taskKind === 'reflection' ? 1 : 0);
    } finally { f.close(); }
  }
});
test('owned node diagnostics distinguish availability without changing node selection or exposing credentials', async () => {
  const f = fixture({ schedules: [{ ...reviewedReflection(), task_kind: 'reflection', config: { weekly_day: 'friday', weekly_time: '18:00', drift_minutes: 30 } }], nodes: [
    { node_id: 'private-online-disconnected', status: 'online', gateway_connected: false },
    { node_id: 'private-busy-node', status: 'busy', gateway_connected: true },
    { node_id: 'private-offline-node', status: 'offline' },
    { node_id: 'private-other-node', status: 'unknown' },
  ] });
  try { const state = await f.api.inspect(); assert.equal(state.status, 'waiting'); assert.equal(state.reason, 'butler_bootstrap_online_node_required'); assert.equal(state.ownedOnlineNodeCount, 0); assert.deepEqual(state.ownedNodeStatusCounts, { online: 1, busy: 1, offline: 1, other: 1 }); assert.equal(state.canInitialize, false); assert.equal(state.nodeId, null); assert.equal(state.ownedNodes.length, 4); assert.equal(state.ownedNodes.find(node => node.nodeId === 'private-offline-node').status, 'offline'); assert.equal(state.nodeHealthPersistence, 'saved'); assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'waiting'); assert.equal(f.postCount(), 0); } finally { f.close(); }
});
test('future reflection content, schedules, fields, types and out-of-range times remain blocked', async () => {
  const mutations = [
    row => { row.name += '变体'; }, row => { row.type = 'daily'; }, row => { row.message += '发送到外部'; }, row => { row.message = '仅看名称不能授权'; },
    row => { row.prompt = 'another action'; }, row => { row.config.additional = 'anything'; }, row => { delete row.config.drift_minutes; },
    ...[-1,7,'6',1.5].map(value => row => { row.config.weekly_day = value; }),
    ...['24:00','12:60','8:00',800].map(value => row => { row.config.weekly_time = value; }),
    ...[-1,61,'15',0.5].map(value => row => { row.config.drift_minutes = value; }),
  ];
  for (const change of mutations) {
    const row = reviewedReflection(); change(row); const f = fixture({ schedules: [row] });
    try { const state = await f.api.ensure({ authorizationExpiresAt: expiry() }); assert.equal(state.reason, 'butler_bootstrap_schedules_present'); assert.equal(state.standardBuiltinReflection, false); assert.equal(f.postCount(), 0); } finally { f.close(); }
  }
  for (const schedules of [[reviewedReflection(), reviewedReflection()], [reviewedReflection()]]) {
    const f = fixture({ schedules, ...(schedules.length === 1 ? { templates: [{ id: 'other', name: '通用助理', has_subs: false }] } : {}) });
    try { assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'blocked'); assert.equal(f.postCount(), 0); } finally { f.close(); }
  }
});
test('reviewed weekly policy accepts fixed weekday encodings and privately reports exact failed guards', async () => {
  for (const weekday of ['monday','tuesday','wednesday','thursday','friday','saturday','sunday','周一','周二','周三','周四','周五','周六','周日','星期一','星期二','星期三','星期四','星期五','星期六','星期日',0,6]) {
    const row = reviewedReflection(); row.config.weekly_day = weekday; const f = fixture({ schedules: [row] });
    try { const state = await f.api.inspect({ includeSchedulePolicy: true }); assert.equal(state.standardBuiltinReflection, true, String(weekday)); assert.equal(state.schedulePolicyDiagnostics[0].timing.weekly_day, weekday); assert.ok(Object.values(state.schedulePolicyChecks).every(value => value === true)); assert.equal(state.schedulePolicyDiagnostics[0].idPrimitiveType, 'undefined'); assert.equal((await f.api.inspect()).schedulePolicyChecks, undefined); } finally { f.close(); }
  }
  for (const enabled of [null, undefined, false, true, 'true']) {
    const row = reviewedReflection(); row.enabled = enabled; const f = fixture({ schedules: [row] });
    try { const state = await f.api.inspect({ includeSchedulePolicy: true }); assert.equal(state.standardBuiltinReflection, enabled !== 'true'); assert.equal(state.schedulePolicyChecks.enabledMetadata, enabled !== 'true'); assert.equal(f.postCount(), 0); } finally { f.close(); }
  }
  for (const taskKind of ['unverified_kind', 'https://private.example', token]) {
    const row = reviewedReflection(); row.task_kind = taskKind; const f = fixture({ schedules: [row] });
    try { const state = await f.api.inspect({ includeSchedulePolicy: true }); assert.equal(state.status, 'blocked'); assert.equal(state.schedulePolicyDiagnostics[0].taskKind, taskKind === 'unverified_kind' ? taskKind : null); assert.equal((await f.api.inspect()).schedulePolicyDiagnostics, undefined); assert.equal(f.postCount(), 0); } finally { f.close(); }
  }
  const row = reviewedReflection(); row.id = 123; row.config.weekly_day = 'unknown-day'; row.unobserved = 'private-extra-value';
  const f = fixture({ schedules: [row] });
  try { const state = await f.api.inspect({ includeSchedulePolicy: true }); assert.equal(state.status, 'blocked'); assert.equal(state.schedulePolicyChecks.weeklyDay, false); assert.equal(state.schedulePolicyChecks.knownRowFields, false); assert.equal(state.schedulePolicyChecks.idMetadata, false); assert.equal(state.schedulePolicyChecks.message, true); assert.equal(state.schedulePolicyDiagnostics[0].idPrimitiveType, 'number'); assert.ok(state.schedulePolicyDiagnostics[0].rowKeys.includes('unobserved')); assert.equal(state.schedulePolicyDiagnostics[0].timing.weekly_day, undefined); assert.ok(!JSON.stringify(state).includes('private-extra-value')); assert.equal(f.postCount(), 0); } finally { f.close(); }
});
test('new built-in installs once with durable pending and verifies actual installed root ownership', async () => {
  const f = fixture(); try { const r = await f.api.ensure({ authorizationExpiresAt: expiry() }); assert.equal(r.status, 'ready'); assert.equal(r.conversationId, rootId); assert.equal(r.ownershipVerified, true); assert.equal(r.primaryRootVerified, true); assert.equal(f.postCount(), 1); const saved = await f.job(); assert.equal(saved.status, 'ready'); assert.equal(saved.details.remoteWritePending, null); assert.equal(saved.details.operationId, undefined); assert.ok(!JSON.stringify(saved).includes(token)); const again = await f.api.ensure({ authorizationExpiresAt: '1970-01-01T00:00:00Z' }); assert.equal(again.status, 'ready'); assert.equal(f.postCount(), 1); } finally { f.close(); }
});
test('missing active root uses official install repair and preserves old ID without reset', async () => {
  const f = fixture({ installed: [{ ...active(), usable: false, conversation_exists: false, conversation_id: oldRootId }] }); try { assert.equal((await f.api.inspect()).reason, 'butler_bootstrap_repair_available'); assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'ready'); const job = await f.job(); assert.equal(job.details.operation, 'repair_missing_main'); assert.equal(job.details.previousConversationId, oldRootId); assert.ok(f.calls.every(call => !/renew|reset/.test(call.path) && call.method !== 'DELETE')); } finally { f.close(); }
});
test('existing good built-in root is reused without a reservation or installation', async () => {
  const f = fixture({ installed: [active()] }); try { assert.equal((await f.api.ensure()).status, 'ready'); assert.equal(f.postCount(), 0); assert.equal(await f.job(), null); } finally { f.close(); }
});
test('expired, ambiguous, unknown, inactive, unavailable, paid, scheduled, non-builtin and disabled states fail closed', async () => {
  for (const options of [
    { installed: [{ ...active(), status: 'expired' }] }, { installed: [active(), active()] }, { installed: [{ ...active(), status: 'future' }] }, { installed: [{ ...active(), status: 'inactive' }] }, { installed: [{ ...active(), usable: false }] }, { installed: [{ ...active(), conversation_exists: null }] },
    { templates: [{ id: 'fake', name: '通用助理', has_subs: false }] }, { templates: [{ id: 'general_assistant', has_subs: true }] }, { templates: [{ id: 'general_assistant', has_subs: false, price_yuan: 39 }] }, { templates: [{ id: 'general_assistant', has_subs: false, billing_tier: { monthly_yuan: '0' } }] },
    { translations: { [bxagiButlerBootstrapProof.badgeKey]: '免费' } }, { schedules: [{ name: 'daily' }] }, { flags: { butler_mode: false, general_mode: true } },
  ]) { const f = fixture(options); try { assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'blocked'); assert.equal(f.postCount(), 0); } finally { f.close(); } }
});
test('wrong owner, employee, parent, primary node and unowned root never become ready or cause reinstall', async () => {
  for (const root of [{ created_by_user_id: 'other-user' }, { employee_id: 'other-employee' }, { parent_conversation_id: oldRootId }, { node_id: 'foreign-node' }, { participants: [{ type: 'agent', is_primary: true, node_id: 'other-node' }] }, { agent_type: 'ReadOnlyAgent' }]) {
    const f = fixture({ installed: [active()], root }); try { const r = await f.api.ensure({ authorizationExpiresAt: expiry() }); assert.equal(r.status, 'blocked'); assert.equal(f.postCount(), 0); } finally { f.close(); }
  }
});
test('offline nodes and expiry cannot authorize install', async () => {
  for (const options of [{ nodes: [] }, { nodes: [{ node_id: 'owned-node', status: 'offline' }] }, { nodes: [{ node_id: 'owned-node', status: 'online', gateway_connected: false }] }]) {
    const f = fixture(options); try { assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'waiting'); assert.equal(f.postCount(), 0); } finally { f.close(); }
  }
  const f = fixture(); try { for (const authorizationExpiresAt of [undefined, 'invalid', '1970-01-01T00:00:00Z', new Date(Date.now()+7200000).toISOString()]) assert.equal((await f.api.ensure({ authorizationExpiresAt })).status, 'blocked'); assert.equal(f.postCount(), 0); } finally { f.close(); }
});
test('concurrent callers issue at most one remote install', async () => {
  const f = fixture(); try { const r = await Promise.all([f.api.ensure({ authorizationExpiresAt: expiry() }), f.api.ensure({ authorizationExpiresAt: expiry() })]); assert.equal(f.postCount(), 1); assert.ok(r.some(item => item.status === 'ready')); } finally { f.close(); }
});
test('a fresh state change to expired blocks the reserved attempt', async () => {
  const f = fixture({ mineAt: count => count === 1 ? [] : [{ ...active(), status: 'expired' }] }); try { assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'blocked'); assert.equal(f.postCount(), 0); assert.equal((await f.job()).status, 'blocked'); } finally { f.close(); }
});
test('pending ordinary activation for this template blocks bootstrap but other employees do not share its reservation', async () => {
  const f = fixture(); try { await f.repository.reserveBxagiMarketActivation(context.userId, { marketId: 'general_assistant', bxagiSubject: context.subject, operationId: crypto.randomUUID() }); assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).reason, 'butler_bootstrap_market_activation_pending'); assert.equal(f.postCount(), 0); } finally { f.close(); }
  const g = fixture(); try { await g.repository.reserveBxagiMarketActivation(context.userId, { marketId: 'video-employee', bxagiSubject: context.subject, operationId: crypto.randomUUID() }); assert.equal((await g.api.ensure({ authorizationExpiresAt: expiry() })).status, 'ready'); } finally { g.close(); }
});
test('timeout, 409, 5xx and invalid receipts remain unknown and never resend', async () => {
  for (const post of [() => { throw new Error(token); }, () => json({},409), () => json({},503), () => json({ main_conversation_id: 'invalid' }), () => json({ main_conversation_id: rootId, employee_id: 'foreign' })]) {
    const f = fixture({ post }); try { const first = await f.api.ensure({ authorizationExpiresAt: expiry() }); assert.equal(first.status, 'needs_reconciliation'); assert.equal((await f.job()).details.remoteWritePending, 'install_builtin_general_assistant'); const again = await f.api.ensure({ authorizationExpiresAt: expiry() }); assert.equal(again.status, 'needs_reconciliation'); assert.equal(f.postCount(),1); assert.ok(!JSON.stringify(first).includes(token)); } finally { f.close(); }
  }
});
test('explicit 402 refusal blocks without renewal and never retries install', async () => {
  const f = fixture({ post: () => json({},402) }); try { assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status,'blocked'); assert.equal((await f.job()).details.remoteWritePending,null); assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status,'blocked'); assert.equal(f.postCount(),1); } finally { f.close(); }
});
test('acknowledged install with delayed root is verified read-only after authorization expiry', async () => {
  let published = false;
  const f = fixture({ mineAt: (_count, installed) => published ? installed : [], post: ({setInstalled}) => { setInstalled([active()]); return json({main_conversation_id:rootId}); } });
  try { assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status, 'waiting'); assert.equal((await f.job()).status, 'starting'); published=true; assert.equal((await f.api.ensure({ authorizationExpiresAt: '1970-01-01T00:00:00Z' })).status, 'ready'); assert.equal(f.postCount(),1); } finally { f.close(); }
});
test('checkpoint failure after acknowledged install preserves pending and never resends', async () => {
  const f = fixture({ repoWrapper: repository => ({ ...repository, async updateJob(user,id,patch) { if(patch.status==='starting') throw new Error('database unavailable'); return repository.updateJob(user,id,patch); } }) });
  try { assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status,'needs_reconciliation'); assert.equal((await f.job()).status,'needs_reconciliation'); assert.equal((await f.api.ensure({ authorizationExpiresAt: expiry() })).status,'needs_reconciliation'); assert.equal(f.postCount(),1); } finally { f.close(); }
});
