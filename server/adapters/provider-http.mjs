/** Fixed-origin provider HTTP transport. Writes are never retried. */
export class AdsError extends Error {
  constructor(code, message, { status = 409, uncertain = false, requestId = null } = {}) {
    super(message); this.name = 'AdsError'; this.code = code; this.status = status; this.uncertain = uncertain; this.requestId = requestId;
  }
}
export function configuration(message, code = 'needs_configuration') { return new AdsError(code, message); }
const ID_KEYS = new Set(['advertiser_id','project_id','promotion_id']);
// Official IDs are int64. Preserve exact decimal tokens instead of rounding them in JS.
export function providerJsonStringify(value, key = '') {
  if (ID_KEYS.has(key) && typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n) return value;
  if (Array.isArray(value)) return '[' + value.map(v => providerJsonStringify(v)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v]) => JSON.stringify(k)+':'+providerJsonStringify(v,k)).join(',') + '}';
  return JSON.stringify(value);
}
function parseProviderJson(text) {
  const exact = text.replace(/([,{]\s*"(?:advertiser_id|project_id|promotion_id)"\s*:\s*)([1-9]\d*)(?=\s*[,}])/g, '$1"$2"');
  return JSON.parse(exact);
}
export async function readBoundedJson(response, maxBytes = 10 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new AdsError('response_too_large', '渠道响应超过安全读取上限');
  const reader = response.body?.getReader(); let size = 0; const chunks = [];
  if (reader) {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new AdsError('response_too_large', '渠道响应超过安全读取上限'); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return parseProviderJson(new TextDecoder().decode(bytes)); } catch { throw new AdsError('invalid_provider_response', '渠道未返回有效 JSON'); }
  }
  throw new AdsError('invalid_provider_response', '渠道响应没有内容');
}
export function createProviderClient({ accessToken, fetcher = fetch, timeoutMs = 12000 }) {
  return async function request(path, { method = 'GET', body, query, allowEmptySuccess = false } = {}) {
    if (!path.startsWith('/open_api/')) throw configuration('非法渠道路径');
    const url = new URL(path, 'https://api.oceanengine.com');
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    const aborter = new AbortController(); const timer = setTimeout(() => aborter.abort(), timeoutMs);
    const write = method !== 'GET'; let response;
    try {
      // Edge runtimes accept manual/follow; reject redirects before any credential forwarding.
      response = await fetcher(url.href, { method, headers: { 'Access-Token': accessToken, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? providerJsonStringify(body) : undefined, signal: aborter.signal, redirect: 'manual' });
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && new URL(response.url).origin !== url.origin)) {
        await response.body?.cancel().catch(() => {});
        throw new AdsError('provider_redirect_refused', '渠道接口重定向已阻止，请核对官方服务地址', { uncertain: write });
      }
      const data = await readBoundedJson(response);
      if (!response.ok) throw new AdsError('provider_http_error', `渠道 HTTP 请求失败（${response.status}）`, { uncertain: write && response.status >= 500, requestId: data.request_id ?? null });
      if (typeof data.code !== 'number') throw new AdsError('invalid_provider_response', '渠道响应缺少结果码', { uncertain: write });
      if (data.code !== 0) throw new AdsError('provider_rejected', `渠道拒绝请求（错误码 ${data.code}），请根据渠道请求编号核查账户与模板`, { requestId: data.request_id ?? null });
      if (allowEmptySuccess && (data.data === null || data.data === undefined)) return { _requestId: data.request_id ?? null, _responseUnverified: true };
      if (!data.data || typeof data.data !== 'object') throw new AdsError('invalid_provider_response', '渠道成功响应缺少结果数据', { uncertain: write });
      return { ...data.data, _requestId: data.request_id ?? null };
    } catch (error) {
      if (error instanceof AdsError) { if (write && ['invalid_provider_response', 'response_too_large'].includes(error.code)) error.uncertain = true; throw error; }
      throw new AdsError('provider_unreachable', write ? '渠道写入结果不明，请在广告后台核对后人工处理；系统不会自动重试' : '无法读取渠道数据，请稍后手动同步', { uncertain: write });
    } finally { clearTimeout(timer); }
  };
}
