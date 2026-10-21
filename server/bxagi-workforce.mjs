/** BXAGI's observed public-client HTTP protocol. No account creation or hiring. */
import { sameBxagiIdentifier } from './bxagi-identifiers.mjs';
import { createBxagiMessageTransport, isMatchingBxagiUserMessage } from './bxagi-message-transport.mjs';
export const BXAGI_ORIGIN = 'https://bxagi.xinlx.com';
export const BXAGI_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const BXAGI_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const BXAGI_MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_JSON_BYTES = BXAGI_MAX_ARTIFACT_BYTES;
const DISCOVERY_PAGE_SIZE = 500;
const DISCOVERY_MAX_PAGES = 2;
const DISCOVERY_MAX_ROWS = 1000;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const JOB_DIRECTORY = new RegExp(`^bxagi-advertising/(${UUID})/(input|output)$`, 'i');
const PLATFORM_EXECUTION_TITLE = new RegExp(`^广告任务 · ${UUID}$`, 'i');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => text(item, 400)).filter(Boolean).slice(0, 100) : [];

export class BxagiProtocolError extends Error {
  constructor(code, message, status = 502, uncertain = false) { super(message); this.name = 'BxagiProtocolError'; this.code = code; this.status = status; this.uncertain = uncertain; }
}
const fail = (code, message, status, uncertain) => { throw new BxagiProtocolError(code, message, status, uncertain); };
function identifier(value) {
  const id = text(value, 256);
  if (!id || id.length > 160 || /[\x00-\x1f\x7f/\\]/.test(id)) fail('invalid_identifier', 'BXAGI 记录标识无效', 400);
  return id;
}
function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('unexpected_response', `BXAGI ${label}响应格式尚不能确认`);
  return value.trim();
}
function ownConversation(raw, id) {
  if (!object(raw) || !sameBxagiIdentifier(requiredString(raw.id, '会话'), id)) fail('unexpected_response', 'BXAGI 会话响应与请求不匹配');
  // Runtime URLs, session keys and credentials are deliberately excluded.
  return {
    id: raw.id, employee_id: text(raw.employee_id, 160) || null,
    created_by_user_id: typeof raw.created_by_user_id === 'number' && Number.isSafeInteger(raw.created_by_user_id)
      ? String(raw.created_by_user_id) : text(raw.created_by_user_id, 200) || null,
    parent_conversation_id: text(raw.parent_conversation_id, 160) || null,
    title: text(raw.title, 12000),
    node_id: text(raw.node_id, 160) || null,
    selected_repository: text(raw.selected_repository, 400) || null,
    selected_branch: text(raw.selected_branch, 400) || null,
    git_provider: text(raw.git_provider, 100) || null,
    memory_space_name: text(raw.memory_space_name, 400) || null,
    agent_type: text(raw.agent_type, 100) || null,
    execution_status: text(raw.execution_status, 100) || null,
    sandbox_status: text(raw.sandbox_status, 100) || null,
    participants: (Array.isArray(raw.participants) ? raw.participants : []).filter(object).map(participant => ({
      type: text(participant.type, 40), id: text(participant.id, 160),
      node_id: text(participant.node_id, 160) || null, is_primary: participant.is_primary === true,
    })),
  };
}
function roleHints(name, description, skills, providerId) {
  const corpus = `${name} ${description} ${skills.join(' ')}`.toLowerCase();
  const roles = [];
  if (/素材|剪辑|设计|视频|创意|文案|content|creative|video|design|editing|image|copywriting/.test(corpus)) roles.push('production');
  if (/投放|广告|营销|运营|media.buy|ads|advertising|marketing|campaign|growth/.test(corpus)) roles.push('buying');
  if (!roles.length && (providerId === 'general_assistant' || /通用助理|通用员工|general.assistant/.test(corpus))) roles.push('production', 'buying');
  return roles;
}
const SCENE_TERMS = ['服装', '衣服', '外套', '衬衫', '裤子', '美妆', '护肤', '汽车', '教育', '家居', '食品', '短剧', '影视', '剧情', '游戏', '手游', '应用', 'apparel', 'clothing', 'drama', 'gaming', 'game', 'beauty', 'automotive'];

/** Factory receives a server-verified subject and server-only credential. */
export function createBxagiWorkforce({ accessToken, subject, fetcher = fetch, timeoutMs = 15000, artifactTimeoutMs = 60000, messageTransport } = {}) {
  if (typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 32000) fail('workforce_unauthorized', '需要已验证的 BXAGI 登录凭据', 401);
  const userId = identifier(typeof subject === 'string' ? subject : subject?.id);
  const token = accessToken.trim();
  const timeout = Math.max(100, Math.min(20000, Number(timeoutMs) || 15000));
  const artifactTimeout = Math.max(100, Math.min(120000, Number(artifactTimeoutMs) || 60000));
  const redact = value => text(value, 16000).split(token).join('[redacted]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
  const sanitizedDeliveryText=value=>typeof value!=='string'?null:value.split(token).join('[redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi,'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,'[redacted JWT]')
    .replace(/\b(?:sk|rk|sess)[_-][A-Za-z0-9_-]{8,}\b/gi,'[redacted key]')
    .replace(/(["']?\b(?:api[_ -]?key|access[_ -]?token|session[_ -]?(?:api[_ -]?)?key|password|secret|authorization|credential|token|APP_ENCRYPTION_KEY)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1[redacted]')
    .replace(/\b(?:settings|environment|env|headers)\s*[:=]\s*[\{\[][\s\S]*/gi,'[redacted configuration]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim()||null;
  const deliveryText=value=>sanitizedDeliveryText(value)?.slice(0,2000)||null;
  let discoveryStatus = { pages: 0, conversationCount: 0, ledgerCount: 0, rootCount: 0, ownedRootCount: 0, nodeCount: 0, usableCount: 0, limitReached: false, excludedReasons: {} };

  async function request(path, { method = 'GET', body, headers = {}, limit = MAX_JSON_BYTES, deadlineMs = timeout } = {}) {
    const url = new URL(path, BXAGI_ORIGIN);
    if (url.origin !== BXAGI_ORIGIN || !path.startsWith('/api/')) fail('invalid_endpoint', 'BXAGI 请求地址无效', 400);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    const dispose = () => clearTimeout(timer);
    let response;
    try {
      // workerd supports follow/manual, so refuse redirects explicitly before
      // inspecting a response body or sending credentials to another address.
      response = await fetcher(url.href, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` }, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status <= 399 || response.redirected || response.url && new URL(response.url).origin !== BXAGI_ORIGIN) {
        await response.body?.cancel().catch(() => {});
        fail('redirect_refused', 'BXAGI 请求发生了不允许的重定向');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = [401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
        fail(response.status === 401 ? 'workforce_unauthorized' : response.status === 403 ? 'workforce_forbidden' : 'upstream_request_failed', 'BXAGI 接口未完成请求，请检查登录、员工权限与服务状态', status, method === 'POST' && response.status >= 500);
      }
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
        await response.body?.cancel().catch(() => {}); fail('response_too_large', 'BXAGI 响应超过允许的大小');
      }
      const reader = response.body?.getReader();
      if ([204, 205].includes(response.status)) { dispose(); await reader?.cancel().catch(() => {}); return new Response(null, { status: response.status }); }
      let count = 0;
      const bounded = new ReadableStream({
        async pull(stream) {
          try {
            if (!reader) { dispose(); stream.close(); return; }
            const part = await reader.read();
            if (part.done) { dispose(); stream.close(); return; }
            count += part.value.byteLength;
            if (count > limit) { await reader.cancel().catch(() => {}); fail('response_too_large', 'BXAGI 响应超过允许的大小'); }
            stream.enqueue(part.value);
          } catch (error) {
            dispose(); controller.abort();
            stream.error(error instanceof BxagiProtocolError ? error : new BxagiProtocolError(timedOut?'upstream_stream_timeout':'upstream_stream_failed', timedOut?'BXAGI 文件传输超时，尚未完整读取':'BXAGI 文件读取未完成'));
          }
        },
        async cancel(reason) { dispose(); controller.abort(); await reader?.cancel(reason).catch(() => {}); },
      });
      const cleanHeaders = new Headers();
      const mime = response.headers.get('Content-Type'); if (mime) cleanHeaders.set('Content-Type', mime);
      if (length !== null) cleanHeaders.set('Content-Length', length);
      return new Response(bounded, { status: response.status, headers: cleanHeaders });
    } catch (error) {
      dispose(); controller.abort();
      if (error instanceof BxagiProtocolError) { if (method === 'POST' && ![401, 403, 404, 409, 422, 429].includes(error.status)) error.uncertain = true; throw error; }
      fail('upstream_unavailable', 'BXAGI 服务连接未完成，请检查远端执行状态', 502, method === 'POST');
    }
  }
  async function json(path, options) {
    const response = await request(path, options);
    try { return await response.json(); }
    catch (error) { if (error instanceof BxagiProtocolError) { if (options?.method === 'POST') error.uncertain = true; throw error; } fail('unexpected_response', 'BXAGI JSON 响应格式尚不能确认', 502, options?.method === 'POST'); }
  }
  async function smallJson(path,options={},limit=BXAGI_MAX_MANIFEST_BYTES){
    const response=await request(path,{...options,limit});
    try{return await response.json();}catch(error){if(error instanceof BxagiProtocolError)throw error;fail('unexpected_response','BXAGI 文件列表或文本响应格式尚不能确认');}
  }
  function outputPath(relativePath) {
    const path = text(relativePath, 2000);
    const parts = path.split('/');
    if (parts.length < 4 || !JOB_DIRECTORY.test(parts.slice(0, 3).join('/')) || parts[2] !== 'output'
      || parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f\\%?#]/.test(part))) fail('invalid_artifact_path', 'BXAGI 成品必须来自任务专属输出目录', 400);
    return path;
  }
  function conversationNode(conversation) {
    if (!object(conversation) || !conversation.id) fail('invalid_conversation', '缺少已授权的 BXAGI 会话', 400);
    const node = conversation.node_id || conversation.participants?.find(participant => participant.type === 'agent' && participant.is_primary)?.node_id
      || conversation.participants?.find(participant => participant.type === 'agent')?.node_id;
    if (!node) fail('node_unavailable', '该 BXAGI 员工会话尚未绑定可用节点', 409);
    return identifier(node);
  }
  const isOwned = conversation => conversation.created_by_user_id === userId;
  const isRootAgent = conversation => !conversation.parent_conversation_id && (
    ['AgiAgent', 'CodeActAgent'].includes(conversation.agent_type)
    || conversation.participants.some(participant => participant.type === 'agent')
    || conversation.memory_space_name?.startsWith('health_')
  );
  const ledgerBlock = entry => entry?.status === 'expired' ? 'expired'
    : entry?.usable === false ? 'disabled'
    : entry?.conversation_exists === false ? 'missing_conversation' : null;
  function resourceBlock(providerId, conversationId, ledger) {
    const exact = ledger.filter(entry => sameBxagiIdentifier(entry.conversation_id, conversationId));
    const blockedExact = exact.map(ledgerBlock).find(Boolean);
    if (blockedExact) return blockedExact;
    const sameEmployee = providerId ? ledger.filter(entry => entry.employee_id === providerId) : [];
    if (sameEmployee.length && sameEmployee.every(entry => ledgerBlock(entry))) return ledgerBlock(sameEmployee[0]);
    return null;
  }
  async function readLedger() {
    const result = await json('/api/v1/employees/mine?include_inactive=true&locale=zh');
    if (!object(result) || !Array.isArray(result.items) || result.items.length > DISCOVERY_MAX_ROWS
      || result.items.some(entry => !object(entry) || !text(entry.employee_id, 160))) fail('unexpected_response', 'BXAGI 员工状态账本响应格式尚不能确认');
    return result.items;
  }
  async function readNodes() {
    const result = await json('/api/nodes?include_shared=true');
    if (!object(result) || !Array.isArray(result.nodes) || result.nodes.length > DISCOVERY_MAX_ROWS
      || result.nodes.some(node => !object(node) || !text(node.node_id, 160))) fail('unexpected_response', 'BXAGI 已授权节点响应格式尚不能确认');
    return new Map(result.nodes.map(node => [node.node_id, { id: node.node_id, status: text(node.status, 80), gatewayConnected: node.gateway_connected !== false }]));
  }
  function availability(conversation, nodes, block) {
    if (block) return block;
    if (!conversation) return 'conversation_unverified';
    if (!isOwned(conversation)) return 'ownership_unverified';
    if (!isRootAgent(conversation)) return 'not_root_agent';
    let nodeId;
    try { nodeId = conversationNode(conversation); } catch { return 'node_unavailable'; }
    const node = nodes.get(nodeId);
    if (!node) return 'node_unavailable';
    if (node.status === 'offline' || !node.gatewayConnected) return 'node_offline';
    if (!['online', 'busy'].includes(node.status)) return 'node_status_unknown';
    if (conversation.sandbox_status === 'ERROR' || conversation.execution_status === 'error') return 'runtime_error';
    return 'ready';
  }
  async function discoverConversations() {
    const found = new Map(), cursors = new Set();
    let cursor = null, pages = 0, truncated = false;
    while (pages < DISCOVERY_MAX_PAGES && found.size < DISCOVERY_MAX_ROWS) {
      const params = new URLSearchParams({ limit: String(DISCOVERY_PAGE_SIZE), include_sub_conversations: 'true', include_total: 'true' });
      if (cursor) params.set('page_id', cursor);
      const result = await json(`/api/v1/app-conversations?${params}`);
      if (!object(result) || !Array.isArray(result.items)) fail('unexpected_response', 'BXAGI 工作会话目录响应格式尚不能确认');
      pages++;
      for (const raw of result.items) {
        if (!object(raw) || !text(raw.id, 160)) fail('unexpected_response', 'BXAGI 工作会话目录响应格式尚不能确认');
        const id = identifier(raw.id);
        if (found.size < DISCOVERY_MAX_ROWS || found.has(id)) found.set(id, ownConversation(raw, id));
        else truncated = true;
      }
      // page_id is observed in the public client. Follow only an explicit
      // server cursor; never fabricate a page number or infer unseen fields.
      const next = typeof result.next_page_id === 'string' ? result.next_page_id.trim() : null;
      if (!next) {
        truncated ||= typeof result.total === 'number' && result.total > found.size;
        break;
      }
      if (next.length > 2000 || /[\x00-\x1f\x7f]/.test(next) || cursors.has(next)) { truncated = true; break; }
      cursors.add(next); cursor = next;
      if (pages >= DISCOVERY_MAX_PAGES || found.size >= DISCOVERY_MAX_ROWS) truncated = true;
    }
    return { found, pages, truncated };
  }
  async function readMissingLedgerConversations(ledger, found) {
    const ids = [...new Set(ledger.map(entry => text(entry.conversation_id, 160)).filter(id => id && !found.has(id)))];
    if (!ids.length) return;
    // Keep query strings bounded even when a large ledger references older
    // conversations outside the recent-workforce page.
    const batches = []; for (let index = 0; index < ids.length; index += 100) batches.push(ids.slice(index, index + 100));
    await Promise.all(batches.map(async batch => {
      // Official batchGet omits this flag when live status is requested.
      const params = new URLSearchParams();
      batch.forEach(id => params.append('ids', identifier(id)));
      const result = await json(`/api/v1/app-conversations?${params}`);
      if (!Array.isArray(result)) fail('unexpected_response', 'BXAGI 员工会话复核响应格式尚不能确认');
      const requested = new Set(batch);
      for (const raw of result) {
        if (!object(raw) || !requested.has(raw.id)) fail('unexpected_response', 'BXAGI 员工会话复核响应与请求不匹配');
        found.set(raw.id, ownConversation(raw, raw.id));
      }
    }));
  }

  const api = {
    async listEmployees() {
      const [ledger, templates, discovered, nodes] = await Promise.all([
        readLedger(),
        json('/api/v1/employees/templates?locale=zh'),
        discoverConversations(),
        readNodes(),
      ]);
      if (!Array.isArray(templates)) fail('unexpected_response', 'BXAGI 员工目录响应格式尚不能确认');
      await readMissingLedgerConversations(ledger, discovered.found);
      const templateMap = new Map();
      for (const entry of templates) { if (!object(entry) || !text(entry.id, 160)) fail('unexpected_response', 'BXAGI 员工模板响应格式尚不能确认'); templateMap.set(entry.id, entry); }
      const result = [], seenIds = new Set(), seenConversations = new Set(), excludedReasons = {};
      const excluded = reason => { excludedReasons[reason] = (excludedReasons[reason] || 0) + 1; };
      for (const entry of ledger) {
        const providerId = identifier(entry.employee_id), template = templateMap.get(providerId) || {};
        const conversationId = text(entry.conversation_id, 160) || null;
        const source = conversationId ? discovered.found.get(conversationId) : null;
        if (source && !isOwned(source)) { excluded(source.created_by_user_id ? 'foreign_owner' : 'owner_missing'); continue; }
        const state = availability(source, nodes, resourceBlock(providerId, conversationId, ledger));
        const name = redact(text(entry.name, 180) || text(template.name, 180) || providerId);
        const description = redact(text(template.description, 12000));
        const skills = strings(template.skills).map(redact), tags = strings(template.tags).map(redact);
        const corpus = `${name} ${description} ${skills.join(' ')} ${tags.join(' ')}`.toLowerCase();
        if (seenIds.has(`bxagi:${providerId}`)) continue;
        seenIds.add(`bxagi:${providerId}`); if (conversationId) seenConversations.add(conversationId);
        if (state !== 'ready') excluded(state);
        result.push({
          id: `bxagi:${providerId}`, providerId, name, description, skills, provider: 'bxagi',
          resourceType: 'installed_employee',
          roleCandidates: roleHints(name, description, skills, providerId),
          sceneKeywords: [...new Set([...tags, ...SCENE_TERMS.filter(term => corpus.includes(term))])],
          usable: state === 'ready', availability: state,
          providerUsable: typeof entry.usable === 'boolean' ? entry.usable : null,
          providerConversationExists: typeof entry.conversation_exists === 'boolean' ? entry.conversation_exists : null,
          subscriptionExpired: entry.status === 'expired',
          conversationId, memorySpaceName: source?.memory_space_name || text(entry.memory_space_name, 400) || null,
          nodeId: source?.node_id || null, agentType: source?.agent_type || null,
          ownershipVerified: !!source && isOwned(source),
          category: redact(text(template.category, 200)),
          // Routing hints are inferred from metadata; they do not prove tools can run.
          routingBasis: 'provider_metadata', liveVerified: false, discoveryTruncated: discovered.truncated,
        });
      }
      for (const source of discovered.found.values()) {
        if (!isOwned(source)) { excluded(source.created_by_user_id ? 'foreign_owner' : 'owner_missing'); continue; }
        if (!isRootAgent(source)) { excluded(source.parent_conversation_id ? 'child_conversation' : 'not_agent'); continue; }
        if (seenConversations.has(source.id)) continue;
        // Our dedicated execution roots are jobs, not additional employees.
        // A ledger-backed employee remains governed by the official ledger above.
        if (PLATFORM_EXECUTION_TITLE.test(source.title)) { excluded('execution_run'); continue; }
        const providerId = source.employee_id || null, template = providerId ? templateMap.get(providerId) || {} : {};
        const title = redact(source.title), name = title.split('\n')[0].trim() || text(template.name, 180) || source.id;
        const description = redact(title.split('\n').slice(1).join('\n').trim() || text(template.description, 12000));
        const skills = strings(template.skills).map(redact), tags = strings(template.tags).map(redact);
        const corpus = `${name} ${description} ${skills.join(' ')} ${tags.join(' ')}`.toLowerCase();
        const state = availability(source, nodes, resourceBlock(providerId, source.id, ledger));
        const hints = roleHints(name, description, skills, providerId);
        const roles = ['AgiAgent', 'CodeActAgent'].includes(source.agent_type) ? [...new Set([...hints, 'production', 'buying'])] : hints;
        let nodeId = null; try { nodeId = conversationNode(source); } catch {}
        if (state !== 'ready') excluded(state);
        result.push({
          id: `bxagi:conversation:${source.id}`, providerId, provider: 'bxagi', resourceType: 'conversation',
          name, description, skills, roleCandidates: roles,
          sceneKeywords: [...new Set([...tags, ...SCENE_TERMS.filter(term => corpus.includes(term))])],
          usable: state === 'ready', availability: state, ownershipVerified: true,
          providerUsable: null, providerConversationExists: true, subscriptionExpired: state === 'expired',
          conversationId: source.id, memorySpaceName: source.memory_space_name, nodeId, agentType: source.agent_type,
          executionStatus: source.execution_status, category: redact(text(template.category, 200)),
          routingBasis: 'owned_root_conversation', liveVerified: false, discoveryTruncated: discovered.truncated,
        });
        seenConversations.add(source.id);
      }
      const rows = [...discovered.found.values()];
      discoveryStatus = {
        pages: discovered.pages, conversationCount: rows.length, ledgerCount: ledger.length, nodeCount: nodes.size,
        rootCount: rows.filter(isRootAgent).length, ownedRootCount: rows.filter(source => isOwned(source) && isRootAgent(source)).length,
        usableCount: result.filter(entry => entry.usable).length, limitReached: discovered.truncated, excludedReasons,
      };
      return result;
    },
    discoveryDiagnostics() { return { ...discoveryStatus, excludedReasons: { ...discoveryStatus.excludedReasons } }; },
    async getConversation(conversationId) {
      const id = identifier(conversationId);
      const result = await json(`/api/v1/app-conversations?${new URLSearchParams({ ids: id })}`);
      if (!Array.isArray(result)) fail('unexpected_response', 'BXAGI 会话查询响应格式尚不能确认');
      const row = result.find(entry => object(entry) && sameBxagiIdentifier(entry.id, id));
      if (!row) fail('conversation_not_found', 'BXAGI 会话不存在或当前账号无权读取', 404);
      const source = ownConversation(row, id);
      if (!isOwned(source)) fail('conversation_owner_mismatch', 'BXAGI 会话归属未通过当前账号验证', 403);
      return source;
    },
    async createConversation({ employee, jobId }) {
      if (!object(employee) || employee.provider !== 'bxagi' || employee.usable !== true) fail('employee_unavailable', '该 BXAGI 员工当前不可执行', 409);
      if (!new RegExp(`^${UUID}$`, 'i').test(jobId || '')) fail('invalid_job', '广告员工任务标识必须为 UUID', 400);
      const [source, ledger, nodes] = await Promise.all([api.getConversation(employee.conversationId), readLedger(), readNodes()]);
      const employeeId = employee.providerId ? identifier(employee.providerId) : null;
      if (employee.resourceType !== 'conversation' && !employeeId) fail('employee_mismatch', 'BXAGI 员工缺少真实实例标识', 409);
      if (employee.resourceType === 'conversation' && PLATFORM_EXECUTION_TITLE.test(source.title)) fail('employee_unavailable', 'BXAGI 广告执行会话不能作为新的员工资源', 409);
      if (source.employee_id !== employeeId) fail('employee_mismatch', 'BXAGI 员工与已授权会话不匹配', 409);
      if (availability(source, nodes, resourceBlock(source.employee_id, source.id, ledger)) !== 'ready') fail('employee_unavailable', '该 BXAGI 已有资源当前不可执行，请检查员工状态与授权节点', 409);
      let agentType=source.agent_type||'AgiAgent';
      if(agentType==='PlanAgent'){
        const agents=await api.listExecutionAgents(),executor=agents.find(a=>a.type==='CodeActAgent'&&a.available!==false);
        if(!executor)fail('execution_agent_unavailable','BXAGI尚未提供可核实的执行智能体，未创建生产会话',409);
        agentType=executor.type;
      }
      const payload = {
        selected_repository: source.selected_repository || 'default',
        title: `广告任务 · ${jobId}`, parent_conversation_id: null,
        agent_type: agentType, enable_plan_mode: false,
        memory_space_name: source.memory_space_name || employee.memorySpaceName || 'default',
        node_id: conversationNode(source), ...(employeeId ? { employee_id: employeeId } : {}),
        ...(source.selected_branch ? { selected_branch: source.selected_branch } : {}),
        ...(source.git_provider ? { git_provider: source.git_provider } : {}),
      };
      // No actual task is sent before the owned inputs have been uploaded.
      const result = await json('/api/v1/app-conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!object(result) || typeof result.id !== 'string' || !result.id.trim()) fail('unexpected_response', 'BXAGI 会话创建响应格式尚不能确认', 502, true);
      let startTaskId;
      try { startTaskId = identifier(result.id); }
      catch { fail('unexpected_response', 'BXAGI 会话创建返回了无法核对的任务标识', 502, true); }
      return { startTaskId, liveVerified: false };
    },
    async listExecutionAgents(){
      const result=await smallJson('/api/v1/agents');
      if(!Array.isArray(result)||result.length>100||result.some(a=>!object(a)||typeof a.id!=='string'))fail('unexpected_agents_response','BXAGI执行智能体目录尚不能确认');
      // The observed /agents capabilities are display labels, not tool keys.
      // Tool names below come from the official agents bundle's default table;
      // they never claim that runtime permissions/configuration were verified.
      const definitions={CodeActAgent:['terminal','file_editor','task_tracker','browser_tool_set'],AgiAgent:['terminal','file_editor','task_tracker','browser_tool_set','agi_memory','create_reminder'],PlanAgent:['glob','grep','planning_file_editor']};
      return result.filter(a=>Object.hasOwn(definitions,a.id)).map(a=>({type:a.id,name:deliveryText(a.name)?.slice(0,180)||a.id,description:deliveryText(a.description)?.slice(0,600)||null,available:typeof a.available==='boolean'?a.available:null,registered:true,capabilities:Array.isArray(a.capabilities)?a.capabilities.filter(c=>typeof c==='string').slice(0,20).map(c=>deliveryText(c)?.slice(0,200)).filter(Boolean):[],tools:[...definitions[a.id]],toolsBasis:'official_agent_definition',runtimeToolsVerified:false}));
    },
    async switchExecutionAgent({conversationId,employeeId,jobId}={}){
      let writeSent=false;
      try{
        if(!new RegExp(`^${UUID}$`,'i').test(jobId||''))fail('invalid_job','执行模式切换只允许当前任务 UUID',400);
        const selectedEmployee=identifier(employeeId),conversation=await api.getConversation(identifier(conversationId));
        if(conversation.title!==`广告任务 · ${jobId}`||conversation.employee_id!==selectedEmployee)fail('execution_task_mismatch','执行模式只能切换已授权市场员工的当前任务会话',409);
        const agents=await api.listExecutionAgents(),executable=type=>agents.find(a=>a.type===type&&a.available!==false);
        if(['CodeActAgent','AgiAgent'].includes(conversation.agent_type)&&executable(conversation.agent_type))return {conversationId:conversation.id,employeeId:selectedEmployee,agentType:conversation.agent_type,executionModeVerified:true,runtimeToolsVerified:false,switched:false,liveVerified:false};
        if(conversation.agent_type!=='PlanAgent'||!executable('CodeActAgent'))fail('execution_agent_unavailable','当前会话不是可修复的规划模式或执行智能体不可用',409);
        writeSent=true;
        const receipt=await json('/api/v1/agents/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent_type:'CodeActAgent',conversation_id:conversation.id})});
        if(!object(receipt)||receipt.agent_type!=='CodeActAgent')fail('execution_switch_unconfirmed','BXAGI未返回可核实的执行模式回执',502,true);
        const fresh=await api.getConversation(conversation.id);
        if(!sameBxagiIdentifier(fresh.id,conversation.id)||fresh.employee_id!==selectedEmployee||fresh.agent_type!=='CodeActAgent'||fresh.title!==conversation.title)fail('execution_switch_unconfirmed','BXAGI执行模式及员工归属尚未读回确认',502,true);
        return {conversationId:fresh.id,employeeId:selectedEmployee,agentType:'CodeActAgent',executionModeVerified:true,runtimeToolsVerified:false,switched:true,liveVerified:false};
      }catch(error){error.writeSent=writeSent;error.uncertain=writeSent;throw error;}
    },
    async ensureExecutionAgent(input){return api.switchExecutionAgent(input);},
    async getStartTask(taskId) {
      const id = identifier(taskId), result = await json(`/api/v1/app-conversations/start-tasks?${new URLSearchParams({ ids: id })}`);
      if (!Array.isArray(result)) fail('unexpected_response', 'BXAGI 启动任务响应格式尚不能确认');
      const row = result.find(entry => object(entry) && sameBxagiIdentifier(entry.id, id));
      if (!row) fail('task_not_found', 'BXAGI 启动任务不存在或当前账号无权读取', 404);
      const status = requiredString(row.status, '启动任务');
      const conversationId = text(row.app_conversation_id, 160) || null;
      if (status === 'READY' && !conversationId) fail('unexpected_response', 'BXAGI 启动任务就绪但未返回真实会话');
      return { startTaskId: id, status, conversationId, liveVerified: false };
    },
    async ensureRuntime({ conversation } = {}) {
      // Resolve the current owned conversation again: a persisted repository or
      // caller-supplied owner is not authority for this runtime-starting GET.
      const owned = await api.getConversation(identifier(conversation?.id));
      const params = new URLSearchParams({ project_name: owned.selected_repository || 'default' });
      const result = await json(`/api/v1/conversations/${encodeURIComponent(owned.id)}/runtime/ensure?${params}`);
      if (!object(result) || !['ready', 'starting', 'missing'].includes(result.status)) fail('unexpected_runtime_response', 'BXAGI 运行时状态尚不能确认');
      // The official response may include runtime addresses or credentials;
      // only this observed status is exposed to the application.
      return { status: result.status, liveVerified: false };
    },
    async uploadFile({ conversationId, directory, filename, blob }) {
      const id = identifier(conversationId);
      if (!JOB_DIRECTORY.test(directory || '') || !directory.endsWith('/input')) fail('invalid_upload_path', 'BXAGI 输入必须上传到任务专属输入目录', 400);
      if (typeof filename !== 'string' || !filename || filename.length > 180 || /[\x00-\x1f\x7f/\\%?#]/.test(filename) || filename === '.' || filename === '..') fail('invalid_upload_path', 'BXAGI 输入文件名无效', 400);
      if (!(blob instanceof Blob) || !blob.size || blob.size > BXAGI_MAX_INPUT_BYTES) fail('invalid_upload', 'BXAGI 单个输入必须是非空实际文件且不超过 64MiB', 413);
      const form = new FormData(); form.append('file', blob, filename);
      // The observed CodeTab passes its selected file-list path through unchanged;
      // neither that caller nor the API wrapper adds a /workspace prefix. The
      // custom directory semantics remain a live integration check.
      const response = await request(`/api/v1/conversations/${encodeURIComponent(id)}/files/upload?${new URLSearchParams({ path: directory })}`, { method: 'POST', body: form });
      // The client does not define the upload response schema. A 2xx receipt is
      // not promoted to a creative or a claim that employee execution finished.
      await response.body?.cancel();
      return { relativePath: `${directory}/${filename}`, transportStatus: response.status, liveVerified: false };
    },
    async sendMessage(conversationId, prompt) {
      const id = identifier(conversationId);
      if (typeof prompt !== 'string' || !prompt.trim() || new TextEncoder().encode(prompt).byteLength > BXAGI_MAX_MANIFEST_BYTES) fail('invalid_prompt', 'BXAGI 员工任务内容无效或超过 256KiB', 400);
      let owned, events;
      try { owned = await api.getConversation(id); events = await api.getEvents(owned.id); }
      catch (error) { error.messageSent = false; error.uncertain = false; throw error; }
      const existing = events.find(event => !event.id.includes(token) && isMatchingBxagiUserMessage(event, prompt, { conversationId: owned.id }));
      if (existing) return { transport: 'bxagi_events', messageAcknowledged: true, eventId: existing.id, alreadyDelivered: true, liveVerified: false };
      const transport = messageTransport || createBxagiMessageTransport({ accessToken: token, fetcher, timeoutMs: timeout });
      const receipt = await transport.send({ conversationId: owned.id, prompt, knownEventIds: events.map(event => event.id).filter(Boolean) });
      if (receipt?.messageAcknowledged !== true || !text(receipt.eventId, 160)) throw Object.assign(new BxagiProtocolError('message_acknowledgement_missing', 'BXAGI 指令回执尚未确认', 502, true), { messageSent: true });
      return receipt;
    },
    async getEvents(conversationId) {
      const id = identifier(conversationId);
      const result = await json(`/api/v1/conversation/${encodeURIComponent(id)}/events/search?limit=100&sort_order=TIMESTAMP_DESC`);
      if (!object(result) || !Array.isArray(result.items)) fail('unexpected_response', 'BXAGI 会话事件响应格式尚不能确认');
      return result.items.map(event => {
        if (!object(event)) fail('unexpected_response', 'BXAGI 会话事件响应格式尚不能确认');
        return {
          id: text(event.id, 160), kind: text(event.kind, 100), source: text(event.source, 40), timestamp: text(event.timestamp, 100),
          ...(object(event.llm_message) ? { llm_message: { role: text(event.llm_message.role, 40), content: Array.isArray(event.llm_message.content) ? event.llm_message.content.filter(item => object(item) && item.type === 'text').map(item => ({ type: 'text', text: redact(item.text) })) : typeof event.llm_message.content === 'string' ? [{type:'text',text:redact(event.llm_message.content)}] : [] } } : {}),
          ...(object(event.action) ? { action: { kind: text(event.action.kind, 100) } } : {}),
          ...(object(event.observation) ? { observation: { kind: text(event.observation.kind, 100) } } : {}),
          ...(event.key === 'execution_status' && typeof event.value === 'string' ? { key: event.key, value: text(event.value, 100) } : event.key==='full_state'&&object(event.value)&&typeof event.value.execution_status==='string'&&['loading','init','idle','running','paused','stopped','finished','rejected','error','stuck','rate_limited','awaiting_user_confirmation','waiting_for_confirmation','user_confirmed','user_rejected','awaiting_user_input'].includes(event.value.execution_status.toLowerCase())?{key:'execution_status',value:event.value.execution_status.toLowerCase()} : {}),
        };
      });
    },
    async inspectJobFiles({conversationId,jobId}={}) {
      if(!new RegExp(`^${UUID}$`,'i').test(jobId||''))fail('invalid_job','只能检查当前任务 UUID 的输入输出目录',400);
      const conversation=await api.getConversation(identifier(conversationId)),nodeId=conversationNode(conversation);
      const repository=conversation.selected_repository||'default';
      const inspect=async(namespace,folder)=>{
        const directory=`bxagi-advertising/${jobId}/${folder}`;
        const path=namespace==='conversation'?`/api/v1/conversations/${encodeURIComponent(conversation.id)}/files?${new URLSearchParams({path:directory})}`:`/api/nodes/${encodeURIComponent(nodeId)}/file/list?${new URLSearchParams({project_name:repository,path:directory})}`;
        try{
          const result=await smallJson(path,namespace==='nodeProject'?{headers:{'X-User-Id':userId}}:{});
          if(!object(result)||!Array.isArray(result.files)||!Array.isArray(result.directories)||result.files.length+result.directories.length>500)return {directory,exists:null,errorCode:'file_list_unverified'};
          const entries=[];let excluded=0;
          for(const [type,rows] of [['file',result.files],['directory',result.directories]])for(const entry of rows){
            const rawPath=entry?.path;
            const relative=typeof rawPath==='string'&&!rawPath.includes('/')?`${directory}/${rawPath}`:rawPath;
            if(!object(entry)||entry.type!==type||typeof relative!=='string'||!relative.startsWith(directory+'/')||relative.length>500||relative.includes(token)||/(?:Bearer|api[_-]?key|session[_-]?key|^sk[_-])/i.test(relative.slice(directory.length+1))||relative.split('/').some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f\x7f\\%?#]/.test(p))){excluded++;continue;}
            entries.push({path:relative,type,...(Number.isSafeInteger(entry.size)&&entry.size>=0?{size:entry.size}:{})});
          }
          return {directory,exists:true,fileCount:entries.filter(e=>e.type==='file').length,directoryCount:entries.filter(e=>e.type==='directory').length,excludedEntryCount:excluded,truncated:entries.length>40,entries:entries.slice(0,40)};
        }catch(error){return {directory,exists:error.status===404?false:null,errorCode:error.status===404?'directory_not_found':[401,403].includes(error.status)?'file_access_refused':'file_list_unavailable'};}
      };
      const [conversationInput,conversationOutput,nodeInput,nodeOutput]=await Promise.all([inspect('conversation','input'),inspect('conversation','output'),inspect('nodeProject','input'),inspect('nodeProject','output')]);
      return {readOnly:true,conversationId:conversation.id,jobId,conversation:{input:conversationInput,output:conversationOutput},nodeProject:{input:nodeInput,output:nodeOutput}};
    },
    async getDeliveryReport({conversationId,jobId,includeToolResults=false}={}) {
      if(!new RegExp(`^${UUID}$`,'i').test(jobId||''))fail('invalid_job','交付诊断只允许当前任务 UUID',400);
      const conversation=await api.getConversation(identifier(conversationId));
      const result=await smallJson(`/api/v1/conversation/${encodeURIComponent(conversation.id)}/events/search?limit=100&sort_order=TIMESTAMP_DESC`,{},1024*1024);
      if(!object(result)||!Array.isArray(result.items)||result.items.length>100)fail('unexpected_response','BXAGI 交付事件响应格式尚不能确认');
      const rows=result.items.filter(object),eventInfo=event=>({eventId:typeof event.id==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(event.id)&&!event.id.includes(token)&&deliveryText(event.id)===event.id?event.id:null,timestamp:typeof event.timestamp==='string'&&Number.isFinite(Date.parse(event.timestamp))?new Date(event.timestamp).toISOString():null});
      const ordered=rows.slice().sort((a,b)=>(Date.parse(b.timestamp)||0)-(Date.parse(a.timestamp)||0));
      const finish=ordered.find(e=>e.kind==='ActionEvent'&&e.source==='agent'&&e.action?.kind==='FinishAction'),errors=[];
      const agentMessage=ordered.find(e=>e.kind==='MessageEvent'&&e.source==='agent'&&e.llm_message?.role==='assistant');
      const content=observation=>Array.isArray(observation.content)?observation.content.filter(c=>object(c)&&c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):typeof observation.content==='string'?observation.content:null;
      const errorKinds=new Set(['FileEditorObservation','StrReplaceEditorObservation','BrowserObservation','MCPToolObservation','FinishObservation','ExecuteBashObservation','TerminalObservation','ErrorObservation']);
      for(const event of ordered){
        if(errors.length>=5)break;
        if(event.kind==='AgentErrorEvent'){
          // Sanitize the complete error before selecting either end: slicing a
          // credential first could leave an unrecognizable secret fragment.
          const full=sanitizedDeliveryText(event.error);
          if(full)errors.push({...eventInfo(event),kind:'AgentErrorEvent',message:full.slice(0,2000),...(full.length>2000?{detailTail:full.slice(-1200)}:{})});continue;
        }
        const observation=event.observation;
        if(event.kind!=='ObservationEvent'||!object(observation)||!errorKinds.has(observation.kind))continue;
        const terminal=['ExecuteBashObservation','TerminalObservation'].includes(observation.kind),exitCode=Number.isInteger(observation.exit_code)?observation.exit_code:object(observation.metadata)&&Number.isInteger(observation.metadata.exit_code)?observation.metadata.exit_code:null;
        if(typeof observation.error!=='string'&&observation.is_error!==true&&!(terminal&&(observation.timeout===true||exitCode!==null&&exitCode!==0)))continue;
        const message=deliveryText(typeof observation.error==='string'?observation.error:content(observation));
        if(message)errors.push({...eventInfo(event),kind:observation.kind,message,...(terminal&&exitCode!==null?{exitCode}:{})});
      }
      const recentToolResults=[];
      if(includeToolResults===true)for(const event of ordered){
        if(recentToolResults.length>=6)break;
        const observation=event.observation;
        if(event.kind!=='ObservationEvent'||!object(observation)||!['TerminalObservation','ExecuteBashObservation'].includes(observation.kind))continue;
        const rawExit=observation.exit_code??(object(observation.metadata)?observation.metadata.exit_code:null),exitCode=Number.isSafeInteger(rawExit)&&rawExit>=-255&&rawExit<=255?rawExit:null;
        // Read observation text only: never return commands, environment dumps or tool metadata.
        const commandLines=new Set(typeof observation.command==='string'?observation.command.split(/\r?\n/).map(line=>line.trim()):[]);
        const message=deliveryText(typeof observation.error==='string'?observation.error:content(observation))?.split(/\r?\n/).filter(line=>{
          const value=line.trim();
          return value&&!commandLines.has(value)&&!/^\s*(?:[$#>+]|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=)/.test(line)&&!/^(?:import\s|from\s\S+\s+import\s|print\s*\(|(?:python[\d.]*|ffmpeg|ffprobe|pip[\d.]*)\s+-)/i.test(value)&&/\b(?:python[\d.]*|pillow|pil|ffmpeg|ffprobe|libav\w*|av|x264|h264|codec\w*|encoder\w*|imageio|numpy|opencv|cv2|module\w*error|importerror|filenotfounderror|permissionerror|traceback|error|failed|failure|unavailable|timeout|timed out|killed|not found|no such file|permission denied)\b/i.test(value);
        }).join('\n').slice(0,800)||null;
        recentToolResults.push({...eventInfo(event),kind:observation.kind,exitCode,message,...(observation.timeout===true?{timedOut:true}:{})});
      }
      let executionAgents;try{executionAgents={verified:true,agents:await api.listExecutionAgents()};}catch{executionAgents={verified:false,errorCode:'execution_agents_unavailable'};}
      return {readOnly:true,conversationId:conversation.id,jobId,agentType:typeof conversation.agent_type==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(conversation.agent_type)?conversation.agent_type:null,executionAgents,eventCount:rows.length,latestFinish:finish?{...eventInfo(finish),message:deliveryText(finish.action.message)}:null,latestAgentMessage:agentMessage?{...eventInfo(agentMessage),message:deliveryText(content(agentMessage.llm_message))}:null,errors,...(includeToolResults===true?{recentToolResults}:{}),successfulDeliveryVerified:false};
    },
    async readJobInput({conversation,relativePath}={}){
      const path=text(relativePath,2000),parts=path.split('/');
      if(parts.length!==4||!JOB_DIRECTORY.test(parts.slice(0,3).join('/'))||parts[2]!=='input'||!(parts[3]==='brief.json'||new RegExp(`^${UUID}\\.[a-z0-9]{1,8}$`,'i').test(parts[3]))||parts.some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f\x7f\\%?#]/.test(p)))fail('invalid_input_path','只能读取当前任务的来源 UUID 文件或 brief.json',400);
      const owned=await api.getConversation(identifier(conversation?.id)),nodeId=conversationNode(owned);
      return request(`/api/nodes/${encodeURIComponent(nodeId)}/file/download-relative/${parts.map(encodeURIComponent).join('/')}?${new URLSearchParams({project_name:owned.selected_repository||'default'})}`,{headers:{'X-User-Id':userId},limit:BXAGI_MAX_ARTIFACT_BYTES});
    },
    async readConversationManifest({conversationId,relativePath}={}) {
      const path=outputPath(relativePath);
      if(!/\/output\/manifest\.json$/.test(path))fail('invalid_manifest_path','会话文本读取只允许当前任务输出清单',400);
      const conversation=await api.getConversation(identifier(conversationId));
      // Official CodeTab reads this endpoint as JSON {content,path,language},
      // not a binary download. Only a UTF-8 manifest is supported here.
      const result=await smallJson(`/api/v1/conversations/${encodeURIComponent(conversation.id)}/files/${encodeURIComponent(path)}`);
      if(!object(result)||typeof result.content!=='string'||new TextEncoder().encode(result.content).byteLength>BXAGI_MAX_MANIFEST_BYTES||(result.path!==undefined&&result.path!==path))fail('invalid_manifest','会话未返回可核实的当前任务文本清单');
      let manifest;try{manifest=JSON.parse(result.content);}catch{fail('invalid_manifest','会话清单内容不是有效 JSON');}
      if(!object(manifest))fail('invalid_manifest','会话清单必须是 JSON 对象');
      return manifest;
    },
    async readArtifact({ conversation, relativePath, maxBytes = BXAGI_MAX_ARTIFACT_BYTES }) {
      const nodeId = conversationNode(conversation), path = outputPath(relativePath);
      const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
      const params = new URLSearchParams({ project_name: text(conversation.selected_repository, 400) || 'default' });
      const limit = Math.min(BXAGI_MAX_ARTIFACT_BYTES, Math.max(1, Number(maxBytes) || BXAGI_MAX_ARTIFACT_BYTES));
      return request(`/api/nodes/${encodeURIComponent(nodeId)}/file/download-relative/${encodedPath}?${params}`, { headers: { 'X-User-Id': userId }, limit, deadlineMs: limit>BXAGI_MAX_MANIFEST_BYTES?artifactTimeout:timeout });
    },
    async readManifest({ conversation, relativePath }) {
      if (!/\/output\/manifest\.json$/.test(relativePath || '')) fail('invalid_manifest_path', 'BXAGI 清单必须是任务输出目录内的 manifest.json', 400);
      const response = await api.readArtifact({ conversation, relativePath, maxBytes: BXAGI_MAX_MANIFEST_BYTES });
      let manifest;
      try { manifest = await response.json(); }
      catch (error) { if (error instanceof BxagiProtocolError) throw error; fail('invalid_manifest', 'BXAGI 员工未交付有效的 JSON 清单'); }
      if (!object(manifest)) fail('invalid_manifest', 'BXAGI 员工交付清单必须是 JSON 对象');
      return manifest;
    },
  };
  return api;
}
