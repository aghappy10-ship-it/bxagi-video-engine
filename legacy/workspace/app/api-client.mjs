/** The only HTTP boundary. Secrets remain in session storage and never enter workspace exports. */
export function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('请输入完整的 HTTP 或 HTTPS 服务地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址只支持 HTTP/HTTPS，不可包含用户信息、查询参数或锚点。');
  }
  return url.href.replace(/\/$/, '');
}
export function endpoint(base, path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('://') || path.includes('..')) {
    throw new Error('无效的生产服务接口路径。');
  }
  return normalizeBaseUrl(base) + path;
}
export function createApiClient({
  getConnection,
  fetch: fetcher,
  timeoutMs = 30000,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const active = new Set();
  async function request(path, {
    method = 'GET',
    body,
    raw = false,
    binary = false,
    headers = {},
    signal,
    timeout = timeoutMs
  } = {}) {
    const connection = {
      ...getConnection()
    };
    const url = endpoint(connection.url, path);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    if (signal?.aborted) cancel();else signal?.addEventListener('abort', cancel, {
      once: true
    });
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    active.add(controller);
    const requestHeaders = {
      ...headers
    };
    if (connection.token) requestHeaders.Authorization = `Bearer ${connection.token}`;
    if (body !== undefined && !raw) requestHeaders['Content-Type'] = 'application/json';
    try {
      const response = await fetcher(url, {
        method,
        headers: requestHeaders,
        signal: controller.signal,
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
      });
      const type = response.headers.get('content-type') || '';
      if (!response.ok) {
        let detail;
        try {
          const data = type.includes('json') ? await response.json() : null;
          detail = typeof data?.detail === 'string' ? data.detail : typeof data?.error === 'string' ? data.error : '';
        } catch {}
        throw new Error(detail || `服务请求失败 (${response.status})。请检查地址、令牌和服务日志。`);
      }
      if (binary) {
        if (!type.includes('video/') && !type.includes('octet-stream')) throw new Error('服务未返回视频文件，下载已拒绝。');
        const blob = await response.blob();
        if (!blob.size) throw new Error('服务返回空文件。');
        if (connection.revision !== getConnection().revision) throw new Error('生产服务配置已更换，请重新提交操作。');
        return blob;
      }
      if (!type.includes('json')) throw new Error('服务没有返回 JSON。当前可能是静态站点，请先启动生产服务并配置地址。');
      const data = await response.json();
      if (connection.revision !== getConnection().revision) throw new Error('生产服务配置已更换，请重新提交操作。');
      return data;
    } catch (error) {
      if (timedOut) throw new Error('生产服务请求超时，请检查连接后重试。');
      throw error;
    } finally {
      clearTimer(timer);
      signal?.removeEventListener('abort', cancel);
      active.delete(controller);
    }
  }
  return {
    request,
    abortAll() {
      for (const controller of active) controller.abort();
    }
  };
}
