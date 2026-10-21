import { BXAGI_ORIGIN, BxagiProtocolError } from './bxagi-workforce.mjs';
import { bxagiIdentifierKey } from './bxagi-identifiers.mjs';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = (code, message, status = 502) => {
  const error = new BxagiProtocolError(code, message, status);
  // Only this module's static local descriptions reach the private diagnostic.
  error.marketDiagnostic = message;
  throw error;
};
function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160 || /[\x00-\x1f\x7f/\\]/.test(value)) fail('invalid_identifier', 'BXAGI 市场记录标识无效', 400);
  return value.trim();
}
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9 ? value : null;
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => string(item, 400)).filter(Boolean).slice(0, 100) : [];
function roleCandidates(name, description, skills, tags) {
  const corpus = `${name} ${description} ${skills.join(' ')} ${tags.join(' ')}`.toLowerCase();
  const roles = [];
  if (/素材|剪辑|设计|视频|创意|文案|content|creative|video|design|editing|image|copywriting/.test(corpus)) roles.push('production');
  if (/投放|广告|营销|media.buy|ads|advertising|marketing|campaign|growth/.test(corpus)) roles.push('buying');
  return roles;
}

/** Read the official employee market. This module never installs or renews. */
export function createBxagiMarketplace({ accessToken, subject, fetcher = fetch, timeoutMs = 15000 } = {}) {
  if (typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 32000) fail('workforce_unauthorized', '需要已验证的 BXAGI 登录凭据', 401);
  const userId = identifier(typeof subject === 'string' ? subject : subject?.id);
  const token = accessToken.trim();
  const timeout = Math.max(100, Math.min(20000, Number(timeoutMs) || 15000));
  const redact = value => string(value, 16000).split(token).join('[redacted]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');

  async function get(path) {
    const url = new URL(path, BXAGI_ORIGIN);
    if (url.origin !== BXAGI_ORIGIN || !path.startsWith('/api/')) fail('invalid_endpoint', 'BXAGI 市场请求地址无效', 400);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    let reader;
    try {
      const response = await fetcher(url.href, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status <= 399 || response.redirected || response.url && new URL(response.url).origin !== BXAGI_ORIGIN) {
        await response.body?.cancel().catch(() => {});
        fail('redirect_refused', 'BXAGI 市场请求发生了不允许的重定向');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = [401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
        fail(status === 401 ? 'workforce_unauthorized' : status === 403 ? 'workforce_forbidden' : 'upstream_request_failed', 'BXAGI 员工市场读取未完成，请检查登录与服务状态', status);
      }
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_JSON_BYTES)) {
        await response.body?.cancel().catch(() => {});
        fail('response_too_large', 'BXAGI 员工市场响应超过允许的大小');
      }
      reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_JSON_BYTES) { await reader.cancel().catch(() => {}); fail('response_too_large', 'BXAGI 员工市场响应超过允许的大小'); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder().decode(bytes)); }
      catch { fail('unexpected_response', 'BXAGI 员工市场 JSON 响应格式尚不能确认'); }
    } catch (error) {
      controller.abort(); await reader?.cancel().catch(() => {});
      if (error instanceof BxagiProtocolError) throw error;
      fail('upstream_unavailable', 'BXAGI 员工市场服务连接未完成');
    } finally { clearTimeout(timer); }
  }
  function rows(value, label, idKey) {
    if (!Array.isArray(value) || value.length > MAX_ROWS || value.some(entry => !object(entry) || !string(entry[idKey], 160))) fail('unexpected_response', `BXAGI ${label}响应格式尚不能确认`);
    return value;
  }
  return {
    async readTemplateDetails(marketId) {
      const id=identifier(marketId),base=`/api/v1/employees/templates/${encodeURIComponent(id)}`;
      const [roles,schedules]=await Promise.all([get(`${base}/roles`),get(`${base}/schedules`)]);
      if(!object(roles)||!Array.isArray(schedules)||schedules.length>100)fail('unexpected_response','BXAGI 市场岗位职责或日程格式尚不能确认');
      return {marketId:id,roleText:redact(string(roles.main_agent?.role_md||roles.main_agent?.role_en_md,8000)),
        scheduleCount:schedules.length,schedules:schedules.filter(object).map(schedule=>({name:redact(string(schedule.name,200)),type:string(schedule.type,80)}))};
    },
    async inspect({ diagnostics = false } = {}) {
      const [rawTemplates, rawPricing, rawMine, rawQuota, rawSettings] = await Promise.all([
        get('/api/v1/employees/templates?locale=zh'),
        get('/api/v1/employees/pricing'),
        get('/api/v1/employees/mine?include_inactive=true&locale=zh'),
        get('/api/billing/free-solo-quota'),
        get('/api/settings'),
      ]);
      const templates = rows(rawTemplates, '员工市场', 'id'), pricing = rows(rawPricing, '员工定价', 'id');
      if (!object(rawMine) || !object(rawQuota) || !object(rawSettings)) fail('unexpected_response', 'BXAGI 员工市场状态响应格式尚不能确认');
      const mine = rows(rawMine.items, '已雇用员工', 'employee_id');
      const isCloudMode = typeof rawSettings.is_cloud_mode === 'boolean' ? rawSettings.is_cloud_mode : null;
      const remaining = count(rawQuota.remaining), quotaCount = count(rawQuota.quota);
      const quota = remaining !== null && quotaCount !== null && remaining <= quotaCount ? { remaining, quota: quotaCount } : null;
      const pricingMap = new Map(pricing.map(tier => [identifier(tier.id), tier]));
      const templateMap = new Map();
      // The official market deduplicates a template appearing in two departments.
      for (const template of templates) {
        const id = identifier(template.id), existing = templateMap.get(id);
        if (!existing || string(template.category, 400).length < string(existing.category, 400).length) templateMap.set(id, template);
      }
      const verifiable = mine.filter(entry => templateMap.has(entry.employee_id) && entry.usable === true && entry.conversation_exists === true && string(entry.conversation_id, 160) && entry.status !== 'expired');
      const sources = new Map(), nodes = new Map(), conversationBatches = [];
      if (verifiable.length) {
        const ids = [...new Set(verifiable.map(entry => identifier(entry.conversation_id)))];
        const batches = []; for (let start = 0; start < ids.length; start += 100) batches.push(ids.slice(start, start + 100));
        const [rawNodes, ...responses] = await Promise.all([
          get('/api/nodes?include_shared=true'),
          ...batches.map(batch => {
            // The official live-status batch request omits skip_live_status;
            // its client only sends that parameter when it is true.
            const params = new URLSearchParams();
            batch.forEach(id => params.append('ids', id));
            return get(`/api/v1/app-conversations?${params}`);
          }),
        ]);
        if (!object(rawNodes)) fail('unexpected_response', 'BXAGI 已授权节点响应格式尚不能确认');
        for (const node of rows(rawNodes.nodes, '已授权节点', 'node_id')) nodes.set(identifier(node.node_id), node);
        responses.forEach((response, index) => {
          const requested = new Set(batches[index].map(bxagiIdentifierKey));
          if (!Array.isArray(response) || response.length > MAX_ROWS) fail('unexpected_response', 'BXAGI 市场员工会话响应格式尚不能确认');
          const verifiedRows = rows(response.filter(source => source !== null), '市场员工会话', 'id');
          if (diagnostics) {
            const publicId = id => /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(id) ? id : '[non-uuid]';
            conversationBatches.push({ requested: batches[index].map(publicId), returnedCount: verifiedRows.length,
              sources: verifiedRows.slice(0,100).map(source => ({ id: publicId(source.id), requested: requested.has(bxagiIdentifierKey(source.id)),
                ownerMatches: String(source.created_by_user_id) === userId,
                marketEmployee: templateMap.has(source.employee_id), parentPresent: !!source.parent_conversation_id })) });
          }
          // The official getAppConversation caller accepts an empty slot while
          // a newly installed source is registering. It remains unverified.
          for (const source of verifiedRows) {
            const id = identifier(source.id);
            const key = bxagiIdentifierKey(id);
            // Extra returned conversations cannot establish an installation or
            // become candidates: retain only explicitly requested source IDs.
            if (!requested.has(key)) continue;
            sources.set(key, source);
          }
        });
      }
      const employees = [...templateMap].map(([marketId, template]) => {
        const matching = mine.filter(entry => entry.employee_id === marketId);
        const liveEntry = matching.find(entry => entry.usable === true && entry.conversation_exists === true && string(entry.conversation_id, 160) && entry.status !== 'expired');
        const entry = liveEntry || matching[0] || null;
        const installation = entry ? {
          providerId: identifier(entry.employee_id),
          conversationId: string(entry.conversation_id, 160) || null,
          status: redact(string(entry.status, 100)) || null,
          usable: typeof entry.usable === 'boolean' ? entry.usable : null,
          conversationExists: typeof entry.conversation_exists === 'boolean' ? entry.conversation_exists : null,
        } : null;
        const tier = object(template.billing_tier) ? template.billing_tier : pricingMap.get(string(template.billing_tier_id, 160));
        const listQuote = { monthly: amount(tier?.monthly_yuan), annual: amount(tier?.annual_yuan), currency: 'CNY' };
        const knownZero = listQuote.monthly === 0 && listQuote.annual === 0;
        const hasSubs = typeof template.has_subs === 'boolean' ? template.has_subs : null;
        const soloQuota = isCloudMode === true && hasSubs === false && (quota?.remaining || 0) > 0;
        const freeVerified = isCloudMode === false || knownZero || soloQuota;
        const freeBasis = isCloudMode === false ? 'private_deployment' : knownZero ? 'zero_price' : soloQuota ? 'solo_quota' : null;
        const quote = freeVerified ? { monthly:0,annual:0,currency:'CNY' } : listQuote;
        const source = liveEntry ? sources.get(bxagiIdentifierKey(liveEntry.conversation_id)) : null;
        const owner = typeof source?.created_by_user_id === 'number' && Number.isSafeInteger(source.created_by_user_id) ? String(source.created_by_user_id) : string(source?.created_by_user_id, 200);
        const participants = Array.isArray(source?.participants) ? source.participants.filter(object) : [];
        const nodeId = string(source?.node_id, 160) || string(participants.find(participant => participant.type === 'agent' && participant.is_primary)?.node_id, 160) || string(participants.find(participant => participant.type === 'agent')?.node_id, 160);
        const node = nodes.get(nodeId);
        const isAgent = !source?.parent_conversation_id && (['AgiAgent', 'CodeActAgent'].includes(source?.agent_type) || participants.some(participant => participant.type === 'agent'));
        const sourceVerified = !!liveEntry && !!source && owner === userId && source.employee_id === liveEntry.employee_id && isAgent && !!node;
        const entitlementVerified = !!liveEntry;
        const authorized = entitlementVerified && sourceVerified;
        const availability = !authorized ? 'identity_unverified' : node.status === 'offline' ? 'node_offline' : node.gateway_connected === false ? 'gateway_disconnected' : !['online', 'busy'].includes(node.status) ? 'node_unavailable' : source.sandbox_status === 'ERROR' || source.execution_status === 'error' ? 'runtime_unavailable' : 'ready';
        const usable = authorized && availability === 'ready';
        const required = !authorized;
        const reason = !required ? 'already_installed'
          : installation?.status === 'expired' ? 'renewal_required'
          : installation ? 'installed_unavailable'
          : isCloudMode === false ? 'private_deployment'
          : knownZero ? 'zero_price_verified'
          : soloQuota ? 'solo_quota_available'
          : isCloudMode === null ? 'deployment_mode_unknown'
          : quote.monthly !== null && quote.annual !== null ? 'payment_required' : 'price_unknown';
        const name = redact(string(template.name, 180) || marketId), description = redact(string(template.description, 12000));
        const skills = strings(template.skills).map(redact), tags = strings(template.tags).map(redact);
        return {
          id: `bxagi:market:${marketId}`, marketId, provider: 'bxagi',
          ...(installation ? { providerId: installation.providerId } : {}),
          name, description, skills, tags, category: redact(string(template.category, 400)),
          industry: redact(string(template.industry, 200)), hasSubs,
          roleCandidates: roleCandidates(name, description, skills, tags),
          installed: !!installation, installation,
          resourceType: installation ? 'installed_employee' : 'marketplace_template',
          marketVerified: true, activationState: authorized ? 'ready' : installation ? 'unverified' : 'not_installed',
          sourceVerified, entitlementVerified, availability, usable,
          ...(sourceVerified ? {
            conversationId: source.id, nodeId,
            memorySpaceName: redact(string(source.memory_space_name, 400)) || null,
            agentType: string(source.agent_type, 100) || null,
          } : {}),
          activation: { required, freeVerified, freeBasis, quote, listQuote, quoteScope:'activation_only', reason },
        };
      });
      return { employees, isCloudMode, quota, ...(diagnostics ? { diagnostics: { conversationBatches } } : {}) };
    },
  };
}
