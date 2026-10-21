/**
 * HTTP payloads and field validation shared by platform routes.
 * These helpers do not authenticate users or select the active tenant.
 */


export const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  }
});

export const fail = (status, message, code) => {
  throw Object.assign(new Error(message), {
    status,
    code
  });
};

export const requireRow = row => row ?? fail(404, '记录不存在', 'not_found');

export const string = (v, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : '';

export const listStrings = (v, max = 100) => Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max).map(x => string(x, 2000)).filter(Boolean) : [];

export const positive = (v, name, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) {
    fail(400, `${name}必须大于0且不超过${max}`, 'invalid_number');
  }
  return v;
};

export const containsSecretKey = value => value && typeof value === 'object' && Object.entries(value).some(([k, v]) => /(?:access.?token|refresh.?token|app.?secret|client.?secret|api.?key|password|authorization|credential|private.?key)|^(?:token|secret)$/i.test(k) || containsSecretKey(v));

export async function parseJson(request) {
  if (!request.body) {
    fail(400, '缺少请求内容', 'invalid_json');
  }
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const {
      value,
      done
    } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > 256 * 1024) {
      await reader.cancel();
      fail(413, '请求内容过大', 'request_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const b of chunks) {
    bytes.set(b, offset);
    offset += b.length;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || Array.isArray(body) || typeof body !== 'object') {
      fail(400, '请求必须是JSON对象', 'invalid_json');
    }
    return body;
  } catch (error) {
    if (error.status) {
      throw error;
    }
    fail(400, 'JSON格式错误', 'invalid_json');
  }
}
