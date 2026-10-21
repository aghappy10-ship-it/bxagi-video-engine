import { BXAGI_ORIGIN, BxagiProtocolError } from './bxagi-workforce.mjs';
import { sameBxagiIdentifier } from './bxagi-identifiers.mjs';
import { projectBxagiNodes } from './bxagi-node-health.mjs';

const TEMPLATE = 'general_assistant';
const UUID = /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,160}$/.test(value);
const fail = (code, status = 502, uncertain = false) => { throw new BxagiProtocolError(code, 'BXAGI 通用助理初始化尚未核实', status, uncertain); };
// Reviewed from the fixed official template on 2026-10-15: internal weekly
// reflection and memory maintenance included in the requested butler setup.
// This is an exact policy pin, not permission for arbitrary scheduled tasks.
const STANDARD_REFLECTION_MESSAGE = '【每周反思周报】现在是我的定期反思时间。请以第一人称完成本周反思周报，并把结论固化进记忆： 1. 回顾本周工作：浏览本周的对话与工作产出，总结我做了什么、关键结果是什么； 2. 盘点被驳回/纠正：哪些动作或回复被用户驳回、纠正或返工，正确做法是什么； 3. 核对记忆中的教训：逐条检查 MEMORY.md 与知识图谱里已记录的经验教训，本周是否真的遵守了，哪些还在重犯； 4. 识别反复出现的问题模式：同类问题是否重复出现，根因是什么，我打算怎么改； 5. 固化反思结论：把新的教训与改进规则写入 MEMORY.md 和知识图谱，过时或已验证无效的结论予以更新或清理。 最后输出一份简短的反思周报作为本轮回复（本周完成 / 被纠正事项 / 教训核对 / 改进计划 四节）。';
const WEEKDAYS = new Set(['monday','tuesday','wednesday','thursday','friday','saturday','sunday','周一','周二','周三','周四','周五','周六','周日','星期一','星期二','星期三','星期四','星期五','星期六','星期日']);
const weeklyDay = value => Number.isInteger(value) && value >= 0 && value <= 6 || typeof value === 'string' && WEEKDAYS.has(value);
function reflectionPolicyChecks(schedules) {
  const row = schedules[0], config = row?.config;
  return {
    uniqueSchedule: schedules.length === 1,
    name: row?.name === '每周反思周报', type: row?.type === 'weekly',
    message: typeof row?.message === 'string' && row.message.replace(/\s+/gu, ' ').trim() === STANDARD_REFLECTION_MESSAGE,
    knownRowFields: object(row) && Object.keys(row).every(key => ['id','name','type','task_kind','message','config','enabled'].includes(key)),
    taskKind: row?.task_kind === undefined || row.task_kind === 'reflection',
    idMetadata: row?.id == null || id(row.id), enabledMetadata: row?.enabled == null || typeof row.enabled === 'boolean',
    configKeys: object(config) && Object.keys(config).length === 3 && Object.keys(config).every(key => ['weekly_day','weekly_time','drift_minutes'].includes(key)),
    weeklyDay: weeklyDay(config?.weekly_day),
    weeklyTime: typeof config?.weekly_time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.weekly_time),
    driftMinutes: Number.isInteger(config?.drift_minutes) && config.drift_minutes >= 0 && config.drift_minutes <= 60,
  };
}
const standardBuiltinReflection = schedules => Object.values(reflectionPolicyChecks(schedules)).every(value => value === true);

// Official client inspected 2026-10-15. This exception applies ONLY to this
// built-in ID, never a name match or an arbitrary zero-cost market employee.
export const bxagiButlerBootstrapProof = Object.freeze({
  templateId: TEMPLATE,
  marketClient: `${BXAGI_ORIGIN}/assets/employee-hire-Bezwyiv5.js`,
  repairClient: `${BXAGI_ORIGIN}/assets/sessions-view-Dg1_yEVs.js`,
  chatClient: `${BXAGI_ORIGIN}/assets/general-chat-YJXoaxho.js`,
  translations: `${BXAGI_ORIGIN}/locales/zh-CN/translation.json`,
  badgeKey: 'EMPLOYEE$BUILTIN_BADGE', badge: '内置 · 免费 · 不占名额',
});

/** Fixed official built-in bootstrap. No renew/reset, production, or dispatch. */
export function createBxagiButlerBootstrap({ repository, context, fetcher = fetch, timeoutMs = 15000 } = {}) {
  const userId = context?.userId || context?.nativeUserId, subject = context?.subject, token = context?.accessToken;
  if (!id(userId) || !id(subject)) fail('butler_bootstrap_invalid_identity', 400);
  if (typeof token !== 'string' || !token || token.length > 32000 || /[\x00-\x20\x7f]/.test(token)) fail('workforce_unauthorized', 401);
  const timeout = Math.min(20000, Math.max(100, Number(timeoutMs) || 15000));
  const safeId = value => id(value) && !value.includes(token);
  const conversationId = value => typeof value === 'string' && UUID.test(value) && !value.includes(token);
  const result = (status, reason, extra = {}) => ({ provider: 'bxagi', mode: 'official_butler_bootstrap', templateId: TEMPLATE, status, reason, liveVerified: false, ...extra });
  const scheduleText = (value, limit = 120) => typeof value !== 'string' ? null : value.split(token).join('[redacted]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b(?:sk|rk|sess)[_-][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/(?:api[_ -]?key|access[_ -]?token|password|secret|authorization|credential|token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '[redacted]')
    .replace(/(?:密码|密钥|令牌|凭据)\s*[:：=]\s*[^\s,，;；}]+/g, '[redacted]')
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s"'<>]+/gi, '[url omitted]').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) || null;
  const scheduleName = value => scheduleText(value);
  function schedulePolicy(schedules) {
    // Private inspection only. Never return full config or persist its contents.
    let remaining = 1000;
    const keys = value => object(value) ? Object.keys(value).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !key.includes(token)).slice(0, 40) : [];
    return schedules.map(row => {
      const config = object(row?.config) ? row.config : {};
      const instructions = [];
      for (const [source, value] of [['schedule', row], ['config', config]]) {
        for (const field of ['prompt','message','instruction','instructions','content','task_message','system_prompt','instruction_text']) {
          const text = scheduleText(value?.[field], remaining);
          if (text && remaining > 0) { instructions.push({ field: `${source}.${field}`, text }); remaining -= text.length; }
        }
      }
      const timing = {};
      for (const field of ['interval','interval_minutes','dayOfWeek','day_of_week','cron_day_of_week','hour','cron_hour','minute','cron_minute','day','cron_day','timezone','weekly_day','weekly_time','drift_minutes']) {
        const value = config[field];
        const timeString = field === 'timezone' ? /^(?:UTC|GMT)(?:[+-]\d{1,2}(?::\d{2})?)?$|^[A-Za-z]{2,20}\/[A-Za-z_]{2,20}$/ : field === 'weekly_time' ? /^\d{1,2}:\d{2}$/ : /^(?:[\d*,/-]{1,20}|mon|tue|wed|thu|fri|sat|sun)$/i;
        if (field === 'weekly_day' ? weeklyDay(value) : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 525600 || typeof value === 'string' && timeString.test(value) && !value.includes(token)) timing[field] = value;
      }
      return { name: scheduleName(row?.name), title: scheduleName(row?.title), type: typeof row?.type === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(row.type) && !row.type.includes(token) ? row.type : null, taskKind: typeof row?.task_kind === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(row.task_kind) && !row.task_kind.includes(token) ? row.task_kind : null, rowKeys: keys(row), idPrimitiveType: row?.id === null ? 'null' : typeof row?.id, configKeys: keys(config), instructions, timing };
    });
  }
  async function request(path, { method = 'GET', body, maxBytes = 1024 * 1024 } = {}) {
    if (!path.startsWith('/') || new URL(path, BXAGI_ORIGIN).origin !== BXAGI_ORIGIN) fail('butler_bootstrap_invalid_endpoint', 400);
    const controller = new AbortController(); let timer, reader, attempted = false, refused = false;
    const work = async () => {
      attempted = true;
      const response = await fetcher(BXAGI_ORIGIN + path, { method, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: controller.signal });
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== BXAGI_ORIGIN) { await response.body?.cancel().catch(() => {}); fail('butler_bootstrap_redirect_refused'); }
      if (!response.ok) {
        // 409 can describe an earlier accepted installation; never infer no write.
        refused = [400,401,402,403,404,422,429].includes(response.status);
        await response.body?.cancel().catch(() => {});
        fail(response.status === 402 ? 'butler_bootstrap_payment_required' : 'butler_bootstrap_request_refused', refused ? response.status : 502);
      }
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) { await response.body?.cancel().catch(() => {}); fail('butler_bootstrap_response_too_large'); }
      const parts = []; let size = 0; reader = response.body?.getReader();
      if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxBytes) fail('butler_bootstrap_response_too_large'); parts.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('butler_bootstrap_invalid_json'); }
    };
    try { return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new BxagiProtocolError('butler_bootstrap_timeout', 'BXAGI 通用助理检查超时', 502)); }, timeout); })]); }
    catch (error) {
      controller.abort(); void reader?.cancel().catch(() => {});
      const failure = error instanceof BxagiProtocolError ? error : new BxagiProtocolError('butler_bootstrap_unavailable', 'BXAGI 通用助理连接尚未完成', 502);
      if (method === 'POST') Object.assign(failure, { uncertain: attempted && !refused, writeSent: attempted, outcomeUnknown: attempted && !refused });
      throw failure;
    } finally { clearTimeout(timer); }
  }
  const rows = (value, key) => {
    if (!Array.isArray(value) || value.length > 1000 || value.some(row => !object(row) || !safeId(row[key]))) fail('butler_bootstrap_unexpected_response');
    return value;
  };
  function explicitPayment(record) {
    if (!object(record)) return false;
    if (record.requires_payment === true || record.payment_required === true || record.is_free === false) return true;
    return ['price','price_yuan','monthly_yuan','annual_yuan','amount_yuan'].some(key => Object.hasOwn(record, key) && record[key] !== null && (typeof record[key] !== 'number' || record[key] !== 0));
  }
  async function readState({ includeSchedulePolicy = false } = {}) {
    const [flags, templates, mine, nodes, translations, schedules] = await Promise.all([
      request('/api/v1/feature-flags'), request('/api/v1/employees/templates?locale=zh', { maxBytes: 16 * 1024 * 1024 }),
      request('/api/v1/employees/mine?include_inactive=true&locale=zh'), request('/api/nodes'),
      request('/locales/zh-CN/translation.json', { maxBytes: 4 * 1024 * 1024 }), request(`/api/v1/employees/templates/${TEMPLATE}/schedules`),
    ]);
    if (!object(flags) || typeof flags.butler_mode !== 'boolean' || !object(mine) || !object(nodes) || !object(translations) || !Array.isArray(schedules) || schedules.length > 100) fail('butler_bootstrap_unexpected_response');
    const templateRows = rows(templates, 'id').filter(row => row.id === TEMPLATE);
    // The official catalog may repeat one template across departments.
    const template = templateRows.slice().sort((a,b) => String(a.category || '').length - String(b.category || '').length)[0];
    const installed = rows(mine.items, 'employee_id').filter(row => row.employee_id === TEMPLATE);
    const ownedNodes = rows(nodes.nodes, 'node_id'), onlineNodes = ownedNodes.filter(node => node.status === 'online' && node.gateway_connected !== false);
    const nodeObservedAt = new Date().toISOString(), safeOwnedNodes = projectBxagiNodes(ownedNodes, { now: Date.parse(nodeObservedAt), token });
    let nodeHealthPersistence = 'unavailable';
    try {
      if (typeof repository?.recordBxagiNodeHealth === 'function') {
        await repository.recordBxagiNodeHealth(userId, subject, { checkedAt: nodeObservedAt, observationStatus: 'verified', nodes: safeOwnedNodes });
        nodeHealthPersistence = 'saved';
      }
    } catch { /* Diagnostics storage must not change the verified upstream state. */ }
    const ownedNodeStatusCounts = { online: 0, busy: 0, offline: 0, other: 0 };
    for (const node of ownedNodes) ownedNodeStatusCounts[['online','busy','offline'].includes(node.status) ? node.status : 'other']++;
    const entry = installed.length === 1 ? installed[0] : null;
    // The official market consumes an array and says installation creates these
    // schedules. Diagnostic labels do not expose config, prompts or instructions,
    // and a missing enabled field is unknown, never assumed disabled.
    const scheduleDiagnostics = schedules.map(row => ({
      id: object(row) && safeId(row.id) && !/(?:token|secret|password|credential|api[_-]?key|^sk[_-]|^sess[_-])/i.test(row.id) ? row.id : null,
      name: object(row) ? scheduleName(row.name) : null,
      type: object(row) && typeof row.type === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(row.type) && !row.type.includes(token) ? row.type : null,
      enabled: object(row) && typeof row.enabled === 'boolean' ? row.enabled : null,
    }));
    // The official butler page gates only on butler_mode. general_mode controls
    // /chat and the dedicated built-in card: when false, employee-hire leaves
    // general_assistant in the ordinary market catalog instead of removing it.
    const report = result('blocked', 'butler_bootstrap_unverified', { readOnly: true, enabled: flags.butler_mode, generalChatEnabled: typeof flags.general_mode === 'boolean' ? flags.general_mode : null, marketVerified: !!template, installed: installed.length > 0, installationStatus: entry && ['active','expired','inactive'].includes(entry.status) ? entry.status : entry ? 'unknown' : null, conversationExists: typeof entry?.conversation_exists === 'boolean' ? entry.conversation_exists : null, conversationId: conversationId(entry?.conversation_id) ? entry.conversation_id : null, nodeId: null, ownedOnlineNodeCount: onlineNodes.length, ownedNodeStatusCounts, primaryRootVerified: false, ownershipVerified: false, freeBasis: null, canInitialize: false, canRepair: false, standardBuiltinReflection: false, scheduleCount: schedules.length, schedules: scheduleDiagnostics });
    Object.assign(report, { ownedNodes: safeOwnedNodes, nodeObservedAt, nodeHealthPersistence });
    if (includeSchedulePolicy === true) { report.schedulePolicyDiagnostics = schedulePolicy(schedules); report.schedulePolicyChecks = reflectionPolicyChecks(schedules); }
    const blocked = reason => ({ report: { ...report, reason }, template, entry, onlineNodes });
    if (!report.enabled) return blocked('butler_bootstrap_feature_disabled');
    if (!template || templateRows.some(row => row.has_subs !== false)) return blocked('butler_bootstrap_builtin_unverified');
    if (translations[bxagiButlerBootstrapProof.badgeKey] !== bxagiButlerBootstrapProof.badge || translations['GENERAL_CHAT$HIRE_BUTTON'] !== '免费雇佣通用助理') return blocked('butler_bootstrap_free_contract_unverified');
    if (templateRows.some(row => explicitPayment(row) || explicitPayment(row.billing_tier)) || installed.some(explicitPayment)) return blocked('butler_bootstrap_payment_required');
    report.standardBuiltinReflection = standardBuiltinReflection(schedules);
    if (schedules.length !== 0 && !report.standardBuiltinReflection) return blocked('butler_bootstrap_schedules_present');
    report.freeBasis = 'official_builtin';
    if (installed.length > 1) return blocked('butler_bootstrap_installation_ambiguous');
    if (!entry) return { report: { ...report, status: onlineNodes.length ? 'available' : 'waiting', reason: onlineNodes.length ? 'butler_bootstrap_initialization_available' : 'butler_bootstrap_online_node_required', canInitialize: onlineNodes.length > 0 }, template, entry, onlineNodes };
    if (entry.status === 'expired') return blocked('butler_bootstrap_renewal_not_authorized');
    if (entry.status !== 'active' || typeof entry.conversation_exists !== 'boolean') return blocked('butler_bootstrap_installation_state_unknown');
    if (entry.conversation_exists === false) return { report: { ...report, status: onlineNodes.length ? 'available' : 'waiting', reason: onlineNodes.length ? 'butler_bootstrap_repair_available' : 'butler_bootstrap_online_node_required', canRepair: onlineNodes.length > 0 }, template, entry, onlineNodes };
    if (entry.usable !== true || !conversationId(entry.conversation_id)) return blocked('butler_bootstrap_installed_unavailable');
    const raw = await request(`/api/v1/app-conversations?ids=${encodeURIComponent(entry.conversation_id)}`);
    if (!Array.isArray(raw) || raw.length > 1) fail('butler_bootstrap_unexpected_response');
    const root = raw[0];
    if (!object(root) || !sameBxagiIdentifier(root.id, entry.conversation_id) || String(root.created_by_user_id) !== subject || root.employee_id !== TEMPLATE || root.parent_conversation_id) return blocked('butler_bootstrap_root_mismatch');
    const participants = Array.isArray(root.participants) ? root.participants.filter(object) : [];
    const primary = participants.filter(row => row.type === 'agent' && row.is_primary === true);
    const nodeId = root.node_id || (primary.length === 1 ? primary[0].node_id : null);
    if (!safeId(nodeId) || primary.length > 1 || primary.length === 1 && primary[0].node_id && primary[0].node_id !== nodeId || !['AgiAgent','CodeActAgent','PlanAgent'].includes(root.agent_type)) return blocked('butler_bootstrap_root_mismatch');
    const node = ownedNodes.find(row => row.node_id === nodeId);
    if (!node) return blocked('butler_bootstrap_owned_node_required');
    Object.assign(report, { nodeId, ownershipVerified: true, primaryRootVerified: true });
    if (!['online','busy'].includes(node.status) || node.gateway_connected === false || root.execution_status === 'error' || root.sandbox_status === 'ERROR') return blocked('butler_bootstrap_runtime_unavailable');
    return { report: { ...report, status: 'ready', reason: 'butler_bootstrap_ready' }, template, entry, onlineNodes };
  }
  const validateJob = job => {
    if (!job || job.userId !== userId || job.type !== 'bxagi_butler_bootstrap' || job.details?.kind !== 'butler_bootstrap' || job.details?.marketId !== TEMPLATE || job.details?.bxagiSubject !== subject || !UUID.test(job.details?.attemptId || '')) fail('butler_bootstrap_reservation_mismatch', 409);
    return job;
  };
  const existingResult = job => result(job.details?.remoteWritePending || job.status === 'needs_reconciliation' ? 'needs_reconciliation' : job.status === 'blocked' ? 'blocked' : 'waiting', job.details?.remoteWritePending || job.status === 'needs_reconciliation' ? 'butler_bootstrap_result_unconfirmed' : job.status === 'blocked' ? 'butler_bootstrap_attempt_blocked' : 'butler_bootstrap_verification_pending', { jobId: job.id, conversationId: conversationId(job.details?.mainConversationId) ? job.details.mainConversationId : null, readOnly: true });
  return Object.freeze({
    async inspect({ includeSchedulePolicy = false } = {}) {
      const report = (await readState({ includeSchedulePolicy: includeSchedulePolicy === true })).report;
      const existing = await repository?.getBxagiButlerBootstrap?.(userId, subject);
      if (!existing) return report;
      validateJob(existing);
      if (existing.details.remoteWritePending || existing.status === 'needs_reconciliation' || existing.status === 'blocked') return { ...report, ...existingResult(existing), canInitialize: false, canRepair: false };
      if (existing.details.mainConversationId && (report.status !== 'ready' || !sameBxagiIdentifier(report.conversationId, existing.details.mainConversationId) || report.nodeId !== existing.details.nodeId)) return { ...report, ...existingResult(existing), canInitialize: false, canRepair: false };
      return report;
    },
    async ensure({ authorizationExpiresAt } = {}) {
      const required = ['getBxagiButlerBootstrap','reserveBxagiButlerBootstrap','claimBxagiJobOperation','releaseBxagiJobOperation','getJob','updateJob','getBxagiMarketActivation'];
      if (required.some(name => typeof repository?.[name] !== 'function')) return result('blocked', 'butler_bootstrap_reservation_unavailable');
      let job, operationId;
      const save = async (status, patch) => {
        const current = validateJob(await repository.getJob(userId, job.id));
        if (current.details.operationId !== operationId) fail('butler_bootstrap_lock_lost', 409, !!job.details.remoteWritePending);
        const next = await repository.updateJob(userId, job.id, { status, details: { ...current.details, ...patch } });
        job = validateJob(next);
        if (job.details.operationId !== operationId) fail('butler_bootstrap_checkpoint_failed', 502, !!job.details.remoteWritePending);
      };
      try {
        job = await repository.getBxagiButlerBootstrap(userId, subject);
        if (job) {
          validateJob(job);
          if (job.details.remoteWritePending || job.status === 'needs_reconciliation' || job.status === 'blocked') return existingResult(job);
        }
        const first = await readState();
        if (!job && first.report.status === 'ready') return first.report;
        if (!job && first.report.status !== 'available') return first.report;
        if (!job) {
          const expiry = Date.parse(authorizationExpiresAt);
          if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 3600000) return result('blocked', 'butler_bootstrap_authorization_expired');
          const activation = await repository.getBxagiMarketActivation(userId, TEMPLATE, subject);
          if (activation && (activation.details?.remoteWritePending || ['reserved','activating','needs_reconciliation'].includes(activation.status))) return result('blocked', 'butler_bootstrap_market_activation_pending');
          const reservation = await repository.reserveBxagiButlerBootstrap(userId, { bxagiSubject: subject, attemptId: crypto.randomUUID() });
          if (!reservation?.claimed) return reservation?.job ? existingResult(validateJob(reservation.job)) : result('waiting', 'butler_bootstrap_reservation_busy');
          job = validateJob(reservation.job);
        }
        operationId = crypto.randomUUID();
        const claimed = await repository.claimBxagiJobOperation(userId, job.id, operationId);
        if (!claimed) return existingResult(job);
        job = validateJob(claimed);
        if (job.details.mainConversationId) {
          // A receipt is not readiness; every return verifies installation/root.
          if (first.report.status === 'ready' && sameBxagiIdentifier(first.report.conversationId, job.details.mainConversationId) && first.report.nodeId === job.details.nodeId) {
            await save('ready', { verifiedAt: new Date().toISOString(), remoteWritePending: null });
            return { ...first.report, jobId: job.id };
          }
          return result('waiting', 'butler_bootstrap_verification_pending', { jobId: job.id, readOnly: true });
        }
        // A prior reserved attempt with no send may continue, but only with fresh
        // scope and the same durable attempt. An attempted POST is never repeated.
        if (job.details.attemptedAt) return existingResult(job);
        const fresh = await readState(), expiry = Date.parse(authorizationExpiresAt);
        if (fresh.report.status === 'ready') { await save('ready', { mainConversationId: fresh.report.conversationId, nodeId: fresh.report.nodeId, verifiedAt: new Date().toISOString() }); return { ...fresh.report, jobId: job.id }; }
        if (fresh.report.status !== 'available' || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 3600000 || Date.parse(job.details.operationExpiresAt) <= Date.now()) {
          await save('blocked', { lastErrorCode: fresh.report.status === 'available' ? 'butler_bootstrap_authorization_expired' : fresh.report.reason });
          return result('blocked', job.details.lastErrorCode, { jobId: job.id });
        }
        const activation = await repository.getBxagiMarketActivation(userId, TEMPLATE, subject);
        if (activation && (activation.details?.remoteWritePending || ['reserved','activating','needs_reconciliation'].includes(activation.status))) { await save('blocked', { lastErrorCode: 'butler_bootstrap_market_activation_pending' }); return result('blocked', 'butler_bootstrap_market_activation_pending', { jobId: job.id }); }
        const nodeId = fresh.onlineNodes[0].node_id;
        await save('installing', { remoteWritePending: 'install_builtin_general_assistant', attemptedAt: new Date().toISOString(), authorizationExpiresAt: new Date(expiry).toISOString(), nodeId, freeBasis: 'official_builtin', operation: fresh.entry ? 'repair_missing_main' : 'initialize', previousConversationId: conversationId(fresh.entry?.conversation_id) ? fresh.entry.conversation_id : null });
        if (job.details.remoteWritePending !== 'install_builtin_general_assistant' || !Number.isFinite(Date.parse(job.details.attemptedAt)) || job.details.nodeId !== nodeId) fail('butler_bootstrap_checkpoint_failed');
        if (expiry <= Date.now() || Date.parse(job.details.operationExpiresAt) <= Date.now()) {
          await save('blocked', { remoteWritePending: null, lastErrorCode: 'butler_bootstrap_authorization_expired' });
          return result('blocked', 'butler_bootstrap_authorization_expired', { jobId: job.id });
        }
        const category = typeof fresh.template.category === 'string' && fresh.template.category.length <= 160 && !fresh.template.category.includes(token) && !/[\x00-\x1f\x7f]/.test(fresh.template.category) ? fresh.template.category : '通用';
        const receipt = await request('/api/v1/employees/install', { method: 'POST', body: { template_id: TEMPLATE, node_id: nodeId, department: category, locale: 'zh' } });
        if (!object(receipt) || !conversationId(receipt.main_conversation_id) || receipt.employee_id !== undefined && receipt.employee_id !== TEMPLATE || receipt.template_id !== undefined && receipt.template_id !== TEMPLATE) fail('butler_bootstrap_receipt_unconfirmed', 502, true);
        await save('starting', { mainConversationId: receipt.main_conversation_id, remoteWritePending: null, receiptReceivedAt: new Date().toISOString() });
        const verified = (await readState()).report;
        if (verified.status !== 'ready' || !sameBxagiIdentifier(verified.conversationId, receipt.main_conversation_id) || verified.nodeId !== nodeId) return result('waiting', 'butler_bootstrap_verification_pending', { jobId: job.id, conversationId: receipt.main_conversation_id, readOnly: true });
        await save('ready', { verifiedAt: new Date().toISOString() });
        return { ...verified, jobId: job.id };
      } catch (error) {
        const pending = !!job?.details?.remoteWritePending;
        // Only an explicit HTTP refusal from the attempted POST proves no new
        // installation. A database/checkpoint failure after POST stays unknown.
        const uncertain = pending && !(error?.writeSent === true && error?.outcomeUnknown === false);
        const code = typeof error?.code === 'string' && /^(?:butler_bootstrap_[a-z_]+|workforce_unauthorized)$/.test(error.code) ? error.code : 'butler_bootstrap_failed';
        if (job && operationId) try { await save(uncertain ? 'needs_reconciliation' : job.details.mainConversationId ? 'starting' : 'blocked', { lastErrorCode: code, remoteWritePending: uncertain ? job.details.remoteWritePending : null }); } catch {}
        return result(uncertain ? 'needs_reconciliation' : job?.details.mainConversationId ? 'waiting' : 'blocked', uncertain ? 'butler_bootstrap_result_unconfirmed' : code, { ...(job ? { jobId: job.id } : {}) });
      } finally { if (job && operationId) await repository.releaseBxagiJobOperation(userId, job.id, operationId).catch(() => {}); }
    },
  });
}
