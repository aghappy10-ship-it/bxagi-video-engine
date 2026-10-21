const BXAGI_ORIGIN = 'https://bxagi.xinlx.com';
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FRAMES = 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x20\x7f/\\]/.test(value);
const uuid = value => /^[a-f0-9]{32}$/i.test(value) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const canonical = value => uuid(value) ? value.replace(/-/g, '').toLowerCase() : value;
const monotonic = () => typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

export class BxagiMessageTransportError extends Error {
  constructor(code, message, status = 502, uncertain = false) {
    super(message); this.name = 'BxagiMessageTransportError'; this.code = code;
    this.status = status; this.uncertain = uncertain; this.messageSent = uncertain;
  }
}

/** The official chat clears its optimistic message on an echoed user event. */
export function isMatchingBxagiUserMessage(event, prompt, { conversationId } = {}) {
  if (!object(event) || !id(event.id) || event.kind !== 'MessageEvent' || event.source !== 'user'
    || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))
    || !object(event.llm_message) || event.llm_message.role !== 'user' || typeof prompt !== 'string') return false;
  if (conversationId && event.conversation_id !== undefined && (!id(event.conversation_id) || canonical(event.conversation_id) !== canonical(conversationId))) return false;
  const content = event.llm_message.content;
  return typeof content === 'string' ? content === prompt : Array.isArray(content) && content.length === 1
    && object(content[0]) && content[0].type === 'text' && content[0].text === prompt;
}

/** Fixed-origin Worker WebSocket client; acceptance requires an actual echo. */
export function createBxagiMessageTransport({ accessToken, fetcher = fetch, timeoutMs = 15000 } = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 32000 || !/^[A-Za-z0-9._~-]+$/.test(accessToken)) throw new BxagiMessageTransportError('workforce_unauthorized', 'BXAGI 消息发送需要有效登录凭据', 401);
  const token = accessToken;
  const timeout = Math.max(50, Math.min(20000, Number(timeoutMs) || 15000));
  return {
    async send({ conversationId, prompt, knownEventIds = [], minimumTimestamp } = {}) {
      if (!id(conversationId)) throw new BxagiMessageTransportError('invalid_identifier', 'BXAGI 消息会话标识无效', 400);
      if (typeof prompt !== 'string' || !prompt.trim() || new TextEncoder().encode(prompt).byteLength > MAX_PROMPT_BYTES) throw new BxagiMessageTransportError('invalid_prompt', 'BXAGI 消息内容无效或超过 256KiB', 400);
      if (!Array.isArray(knownEventIds) || knownEventIds.length > MAX_FRAMES || knownEventIds.some(value => !id(value))) throw new BxagiMessageTransportError('invalid_known_events', 'BXAGI 消息历史标识无效', 400);
      const explicitMinimum = minimumTimestamp === undefined ? null : typeof minimumTimestamp === 'string' ? Date.parse(minimumTimestamp) : NaN;
      if (explicitMinimum !== null && !Number.isFinite(explicitMinimum)) throw new BxagiMessageTransportError('invalid_timestamp', 'BXAGI 消息验证时间无效', 400);
      const query = new URLSearchParams({ resend_all: 'true', resend_limit: '100', resend_sort_order: 'TIMESTAMP_DESC' });
      const url = `${BXAGI_ORIGIN}/sockets/events/${encodeURIComponent(conversationId)}?${query}`;
      const controller = new AbortController(), known = new Set(knownEventIds);
      let socket = null, settled = false, attempted = false, accepted = false, frames = 0, total = 0;
      let minimum = Date.now(), serverTime = NaN, handshakeTick = 0, timer, onOpen, onMessage, onClose, onError;
      let resolveResult, rejectResult;
      const pending = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const close = () => { try { socket?.close(1000, 'message_transport_finished'); } catch {} };
      const finish = (error, receipt) => {
        if (settled) return; settled = true;
        clearTimeout(timer); controller.abort();
        try { if (typeof socket?.removeEventListener === 'function') {
          socket.removeEventListener('open', onOpen); socket.removeEventListener('message', onMessage);
          socket.removeEventListener('close', onClose); socket.removeEventListener('error', onError);
        } } catch {}
        close(); error ? rejectResult(error) : resolveResult(receipt);
      };
      const reject = (code, message, status = 502) => finish(new BxagiMessageTransportError(code, message, status, attempted));
      const sendOnce = () => {
        if (settled || attempted || !accepted || socket?.readyState !== 1) return;
        // Use elapsed time on this machine with the upstream clock, never
        // compare a raw local Unix timestamp against a different server clock.
        minimum = Math.max(explicitMinimum ?? -Infinity, Number.isFinite(serverTime)
          ? serverTime + Math.max(0, monotonic() - handshakeTick) : Date.now());
        // Once send() has been called, even a throw cannot prove non-delivery.
        attempted = true;
        try { socket.send(JSON.stringify({ role: 'user', content: [{ type: 'text', text: prompt }] })); }
        catch { reject('bxagi_ws_send_unconfirmed', 'BXAGI 消息提交结果尚未确认'); }
      };
      timer = setTimeout(() => reject(attempted ? 'bxagi_ws_ack_timeout' : 'bxagi_ws_handshake_timeout', attempted ? 'BXAGI 消息提交后尚未收到匹配回显，请核对远端事件' : 'BXAGI 消息连接尚未就绪'), timeout);
      onOpen = sendOnce;
      onClose = () => reject(attempted ? 'bxagi_ws_closed_unconfirmed' : 'bxagi_ws_not_open', attempted ? 'BXAGI 消息连接关闭，提交结果尚未确认' : 'BXAGI 消息连接未就绪');
      onError = () => reject(attempted ? 'bxagi_ws_error_unconfirmed' : 'bxagi_ws_connection_failed', attempted ? 'BXAGI 消息连接出错，提交结果尚未确认' : 'BXAGI 消息连接未完成');
      onMessage = event => {
        if (settled) return;
        frames++;
        const data = event.data;
        const size = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : data instanceof Blob ? data.size : 0;
        total += size;
        if (size > MAX_FRAME_BYTES || total > MAX_TOTAL_BYTES || frames > MAX_FRAMES) { reject('bxagi_ws_stream_limit', 'BXAGI 消息回显超过允许的大小'); return; }
        if (typeof data !== 'string') return;
        let value; try { value = JSON.parse(data); } catch { return; }
        if (!object(value)) return;
        if (!attempted) { if (id(value.id)) known.add(value.id); return; }
        if (!isMatchingBxagiUserMessage(value, prompt, { conversationId }) || known.has(value.id) || value.id.includes(token) || Date.parse(value.timestamp) < minimum) return;
        // A second-granularity Date and replay stream cannot prove causality.
        // This is evidence of this exact instruction, never a claim of a new
        // socket delivery; the caller scopes it to its unique job and source.
        finish(null, { transport: 'bxagi_ws', transportStatus: 101, messageAcknowledged: true, eventId: value.id, deliveryEvidence: 'matching_user_event', freshEchoVerified: false, liveVerified: false });
      };
      // Deliberately one handshake and one send. A late response is closed after
      // timeout, never promoted into a second dispatch or a successful task.
      void (async () => {
        try {
          const response = await fetcher(url, { method: 'GET', headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `bxc-jwt-${token}` }, redirect: 'manual', signal: controller.signal });
          if (settled) { try { response.webSocket?.accept(); response.webSocket?.close(1000, 'message_transport_finished'); } catch {} await response.body?.cancel().catch(() => {}); return; }
          if (response.status >= 300 && response.status <= 399 || response.redirected || response.url && new URL(response.url).origin !== BXAGI_ORIGIN) {
            await response.body?.cancel().catch(() => {}); reject('redirect_refused', 'BXAGI 消息连接发生了不允许的重定向'); return;
          }
          if (response.status !== 101 || !response.webSocket) {
            await response.body?.cancel().catch(() => {});
            reject('bxagi_ws_upgrade_refused', 'BXAGI 未建立消息连接', [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502); return;
          }
          socket = response.webSocket;
          if (!socket.accept || !socket.addEventListener || !socket.removeEventListener || !socket.send || !socket.close) { reject('bxagi_ws_runtime_unavailable', '当前执行环境无法处理 BXAGI 消息连接'); return; }
          serverTime = Date.parse(response.headers.get('Date') || '');
          handshakeTick = monotonic();
          socket.addEventListener('open', onOpen); socket.addEventListener('message', onMessage);
          socket.addEventListener('close', onClose); socket.addEventListener('error', onError);
          try { socket.binaryType = 'arraybuffer'; socket.accept(); accepted = true; }
          catch { reject('bxagi_ws_accept_failed', 'BXAGI 消息连接接收未完成'); return; }
          sendOnce();
          if (!settled && socket.readyState > 1) onClose();
        } catch { if (!settled) reject('bxagi_ws_connection_failed', 'BXAGI 消息连接未完成'); }
      })();
      return pending;
    },
  };
}
