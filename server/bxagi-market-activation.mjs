import { BXAGI_ORIGIN, BxagiProtocolError } from './bxagi-workforce.mjs';

const MAX_JSON_BYTES = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = (code, message, status = 502, uncertain = false) => { throw new BxagiProtocolError(code, message, status, uncertain); };
function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160 || /[\x00-\x1f\x7f/\\]/.test(value)) fail('invalid_identifier', 'BXAGI 激活记录标识无效', 400);
  return value.trim();
}
const ready = employee => employee?.marketVerified === true && employee.sourceVerified === true && employee.usable === true && employee.activationState === 'ready' && !!text(employee.conversationId, 160);
function eligibility(snapshot, employee) {
  if (employee?.hasSubs !== false) return { allowed: false, reason: 'solo_employee_required' };
  if (employee.installed || employee.installation) return { allowed: false, reason: employee.installation?.status === 'expired' ? 'renewal_not_authorized' : 'existing_installation_unverified' };
  if (snapshot.isCloudMode === false) return { allowed: true, freeBasis: 'private_deployment' };
  const baseQuote = employee.activation?.listQuote || employee.activation?.quote;
  if (baseQuote?.monthly === 0 && baseQuote?.annual === 0 && employee.activation?.freeVerified === true) return { allowed: true, freeBasis: 'zero_price' };
  if (snapshot.isCloudMode === true && Number.isSafeInteger(snapshot.quota?.remaining) && snapshot.quota.remaining > 0) return { allowed: true, freeBasis: 'solo_quota' };
  return { allowed: false, reason: snapshot.isCloudMode === null ? 'deployment_mode_unknown' : 'free_activation_unavailable' };
}

/** Zero-cost market activation, protected by a durable account reservation. */
export function createBxagiMarketActivation({ repository, context, fetcher = fetch, timeoutMs = 15000 } = {}) {
  const userId = identifier(context?.userId || context?.nativeUserId);
  const subject = identifier(context?.subject);
  if (typeof context?.accessToken !== 'string' || !context.accessToken.trim() || context.accessToken.length > 32000) fail('workforce_unauthorized', '免费员工激活需要已验证的 BXAGI 登录', 401);
  const token = context.accessToken.trim(), timeout = Math.max(100, Math.min(20000, Number(timeoutMs) || 15000));
  const safeCode = error => text(error?.code, 100) || 'activation_request_failed';
  async function request(path, { method = 'GET', body } = {}) {
    const url = new URL(path, BXAGI_ORIGIN);
    if (url.origin !== BXAGI_ORIGIN || !path.startsWith('/api/')) fail('invalid_endpoint', 'BXAGI 激活地址无效', 400);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    let reader;
    try {
      const response = await fetcher(url.href, {
        method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        redirect: 'manual', signal: controller.signal,
      });
      if (response.status >= 300 && response.status <= 399 || response.redirected || response.url && new URL(response.url).origin !== BXAGI_ORIGIN) {
        await response.body?.cancel().catch(() => {});
        fail('redirect_refused', 'BXAGI 激活请求发生了不允许的重定向', 502, method === 'POST');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = [400, 401, 402, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
        fail('activation_request_refused', 'BXAGI 未接受员工激活请求', status, method === 'POST' && response.status >= 500);
      }
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_JSON_BYTES)) {
        await response.body?.cancel().catch(() => {});
        fail('response_too_large', 'BXAGI 激活响应超过允许的大小', 502, method === 'POST');
      }
      reader = response.body?.getReader(); const chunks = []; let size = 0;
      if (reader) while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_JSON_BYTES) { await reader.cancel().catch(() => {}); fail('response_too_large', 'BXAGI 激活响应超过允许的大小', 502, method === 'POST'); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder().decode(bytes)); }
      catch { fail('unexpected_response', 'BXAGI 激活 JSON 响应格式尚不能确认', 502, method === 'POST'); }
    } catch (error) {
      controller.abort(); await reader?.cancel().catch(() => {});
      if (error instanceof BxagiProtocolError) throw error;
      fail('upstream_unavailable', 'BXAGI 员工激活连接未完成', 502, method === 'POST');
    } finally { clearTimeout(timer); }
  }
  return {
    async activate(employee, { marketplace } = {}) {
      const marketId = identifier(employee?.marketId);
      const result = (status, reason, extra = {}) => ({ status, reason, marketId, ...extra });
      if (!marketplace?.inspect || !marketplace?.readTemplateDetails) return result('blocked', 'market_verification_unavailable');
      if (!repository?.getBxagiMarketActivation || !repository?.reserveBxagiMarketActivation || !repository?.updateJob) return result('blocked', 'durable_reservation_unavailable');
      if (employee?.provider !== 'bxagi' || employee.marketVerified !== true || employee.id !== `bxagi:market:${marketId}`) return result('blocked', 'market_employee_required');
      let job = null;
      const save = async (status, patch) => {
        const updated = await repository.updateJob(userId, job.id, { status, details: { ...job.details, ...patch } });
        if (!updated || updated.id !== job.id || updated.userId !== userId) fail('activation_checkpoint_failed', '员工激活记录保存未完成');
        job = updated; return job;
      };
      const existingResult = existing => {
        if (existing.userId !== userId || existing.details?.marketId !== marketId || existing.details?.bxagiSubject !== subject) fail('activation_reservation_failed', '员工激活授权记录未通过验证');
        const extra = { jobId: existing.id, ...(existing.details?.mainConversationId ? { conversationId: existing.details.mainConversationId } : {}) };
        if (existing.status === 'needs_reconciliation' || existing.details?.remoteWritePending) return result('needs_reconciliation', 'activation_result_unconfirmed', extra);
        if (existing.details?.mainConversationId) return result('starting', 'activation_pending_verification', extra);
        if (existing.status === 'blocked') return result('blocked', text(existing.details?.lastErrorCode, 100) || 'activation_blocked', extra);
        return result('wait', 'activation_busy', extra);
      };
      const inspectSelected = async () => {
        const snapshot = await marketplace.inspect();
        if (!object(snapshot) || !Array.isArray(snapshot.employees)) fail('unexpected_response', '员工市场检查响应格式尚不能确认');
        const selected = snapshot.employees.find(item => item?.marketId === marketId && item.id === `bxagi:market:${marketId}` && item.marketVerified === true && item.provider === 'bxagi');
        return { snapshot, selected };
      };
      try {
        const existing = await repository.getBxagiMarketActivation(userId, marketId, subject);
        if (existing && (existing.status === 'needs_reconciliation' || existing.details?.remoteWritePending)) return existingResult(existing);
        const first = await inspectSelected();
        if (!first.selected) return result('blocked', 'market_employee_missing');
        if (ready(first.selected)) return result('activated', 'already_activated', { conversationId: first.selected.conversationId, ...(existing ? { jobId: existing.id } : {}) });
        if (existing) return existingResult(existing);
        const allowed = eligibility(first.snapshot, first.selected);
        if (!allowed.allowed) return result('blocked', allowed.reason);
        const details = await marketplace.readTemplateDetails(marketId);
        if (!object(details) || details.marketId !== marketId || !Array.isArray(details.schedules) || !Number.isSafeInteger(details.scheduleCount)) return result('blocked', 'template_schedules_unverified');
        if (details.scheduleCount !== 0 || details.schedules.length !== 0) return result('blocked', 'template_schedules_present');
        const nodeResult = await request('/api/nodes');
        if (!object(nodeResult) || !Array.isArray(nodeResult.nodes) || nodeResult.nodes.length > 1000) fail('unexpected_response', 'BXAGI 安装节点响应格式尚不能确认');
        const node = nodeResult.nodes.find(item => object(item) && item.status === 'online' && item.gateway_connected !== false && text(item.node_id, 160));
        if (!node) return result('wait', 'online_owned_node_required');
        const nodeId = identifier(node.node_id), operationId = crypto.randomUUID();
        const reservation = await repository.reserveBxagiMarketActivation(userId, { marketId, bxagiSubject: subject, operationId });
        if (!reservation?.claimed) return reservation?.job ? existingResult(reservation.job) : result('wait', 'activation_busy');
        job = reservation.job;
        if (!job || job.userId !== userId || job.details?.marketId !== marketId || job.details?.bxagiSubject !== subject || job.details?.operationId !== operationId) fail('activation_reservation_failed', '员工激活授权记录未通过验证');
        // The final fresh check follows reservation, so this account's next
        // installer must wait until the official quota has been updated.
        const fresh = await inspectSelected();
        if (ready(fresh.selected)) {
          await save('activated', { mainConversationId: fresh.selected.conversationId, remoteWritePending: null, activatedAt: new Date().toISOString() });
          return result('activated', 'already_activated', { jobId: job.id, conversationId: fresh.selected.conversationId });
        }
        const finalAllowed = fresh.selected ? eligibility(fresh.snapshot, fresh.selected) : { allowed: false, reason: 'market_employee_missing' };
        if (!finalAllowed.allowed) { await save('blocked', { lastErrorCode: finalAllowed.reason, remoteWritePending: null }); return result('blocked', finalAllowed.reason, { jobId: job.id }); }
        const name = text(fresh.selected.name, 180);
        if (!name || name.includes(token)) { await save('blocked', { lastErrorCode: 'market_employee_name_invalid', remoteWritePending: null }); return result('blocked', 'market_employee_name_invalid', { jobId: job.id }); }
        await save('activating', { remoteWritePending: 'install_market_employee', nodeId, freeBasis: finalAllowed.freeBasis, requestedAt: new Date().toISOString() });
        let receipt, conversationId;
        try {
          receipt = await request('/api/v1/employees/install', { method: 'POST', body: { template_id: marketId, name, node_id: nodeId, primary_agent_name: name, ...(text(fresh.selected.category, 400) ? { department: text(fresh.selected.category, 400) } : {}), period: 'monthly', locale: 'zh' } });
          if (!object(receipt)) fail('unexpected_response', 'BXAGI 安装回执响应格式尚不能确认', 502, true);
          let candidate;
          try { candidate = identifier(receipt.main_conversation_id); }
          catch { fail('unexpected_response', 'BXAGI 安装回执缺少真实员工会话', 502, true); }
          if (candidate.includes(token)) fail('unexpected_response', 'BXAGI 安装回执记录标识无法核对', 502, true);
          conversationId = candidate;
          await save('activated', { mainConversationId: conversationId, remoteWritePending: null, receiptReceivedAt: new Date().toISOString() });
          return result('starting', 'activation_pending_verification', { jobId: job.id, conversationId });
        } catch (error) {
          const uncertain = error?.uncertain === true || !Number.isFinite(error?.status) || error.status >= 500;
          try { await save(uncertain ? 'needs_reconciliation' : 'blocked', { lastErrorCode: safeCode(error), remoteWritePending: uncertain ? 'install_market_employee' : null, ...(conversationId ? { mainConversationId: conversationId } : {}) }); } catch {}
          return result(uncertain ? 'needs_reconciliation' : 'blocked', uncertain ? 'activation_result_unconfirmed' : safeCode(error), { jobId: job.id });
        }
      } catch (error) {
        if (job) {
          const pending = !!job.details?.remoteWritePending;
          try { await save(pending ? 'needs_reconciliation' : 'blocked', { lastErrorCode: safeCode(error), remoteWritePending: pending ? 'install_market_employee' : null }); } catch {}
          return result(pending ? 'needs_reconciliation' : 'blocked', pending ? 'activation_result_unconfirmed' : safeCode(error), { jobId: job.id });
        }
        return result('blocked', safeCode(error));
      }
    },
  };
}
