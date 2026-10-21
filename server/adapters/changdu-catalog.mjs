import { createHash } from 'node:crypto';
import { AWEME_SERIES_CONTRACT } from './changdu-profiles.mjs';
import { parseChangduJson } from './changdu-json.mjs';

const ORIGIN = 'https://openapi.changdupingtai.com';
const MAX_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RESERVED_QUERY = new Set(['distributorid', 'secretkey', 'secret', 'sign', 'ts', 'headersign', 'headerts', 'authorization', 'accesstoken', 'token']);
const FIELDS = ['externalId', 'title', 'episodeCount', 'releaseStatus', 'publishedAt', 'sourceUpdatedAt', 'businessMode', 'sourceUrl'];

export class ChangduCatalogError extends Error {
  constructor(code, message, { status = 502, retryable = false, retryAfterMs } = {}) {
    super(message);
    this.name = 'ChangduCatalogError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function failContract() {
  throw new ChangduCatalogError('changdu_contract_invalid', '常读只读接口协议配置无效，请由管理员核对已验证的接口文档。', { status: 503 });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keysAllowed(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key))) failContract();
}

function fieldPath(value) {
  if (typeof value !== 'string' || value.length > 256 || !value.length) failContract();
  const parts = value.split('.');
  if (parts.length > 12 || parts.some(part => !/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/.test(part) || FORBIDDEN_KEYS.has(part))) failContract();
  return value;
}

function queryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) || FORBIDDEN_KEYS.has(value) || RESERVED_QUERY.has(value.toLowerCase().replaceAll('_', ''))) failContract();
  return value;
}

function queryValue(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  failContract();
}

function readContract(raw) {
  if (raw === undefined) raw = JSON.stringify(AWEME_SERIES_CONTRACT);
  if (typeof raw !== 'string' || raw.length > 32768) failContract();
  let input;
  try { input = JSON.parse(raw); } catch { failContract(); }
  keysAllowed(input, ['version', 'path', 'itemsPath', 'fields', 'query', 'pageSize', 'pageSizeParam', 'pagination', 'timeoutMs']);
  if (input.version !== 1 || typeof input.path !== 'string' || input.path.length > 512 || !/^\/novelsale\/openapi\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(input.path)) failContract();
  // Only exact documented read paths: no URL, escaping, dot segment, query, or write action.
  const actions = input.path.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[/_-]/);
  if (actions.some(part => /^(?:create|update|delete|submit|remove|set|add|edit|insert|patch|post|put|upload|bind|unbind|authorize|revoke|enable|disable|cancel|stop|start|send|publish|launch|change|apply|save|reset|withdraw|pay|purchase)[0-9]*$/.test(part))) failContract();
  fieldPath(input.itemsPath);
  keysAllowed(input.fields, FIELDS);
  for (const name of ['externalId', 'title']) fieldPath(input.fields[name]);
  for (const path of Object.values(input.fields)) fieldPath(path);
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) failContract();
  queryName(input.pageSizeParam);
  const pagination = input.pagination;
  keysAllowed(pagination, ['type', 'parameter', 'initial', 'hasMorePath', 'nextPath', 'totalPath', 'maxPage']);
  queryName(pagination.parameter);
  if (pagination.parameter === input.pageSizeParam) failContract();
  if (pagination.type === 'cursor') {
    if (pagination.totalPath !== undefined || pagination.maxPage !== undefined) failContract();
    fieldPath(pagination.hasMorePath);
    queryValue(pagination.initial);
    fieldPath(pagination.nextPath);
  } else if (pagination.type === 'page') {
    if (!Number.isSafeInteger(pagination.initial) || pagination.initial < 0 || pagination.nextPath !== undefined) failContract();
    if (pagination.totalPath !== undefined) {
      fieldPath(pagination.totalPath);
      if (pagination.hasMorePath !== undefined) failContract();
    } else fieldPath(pagination.hasMorePath);
    if (pagination.maxPage !== undefined && (!Number.isSafeInteger(pagination.maxPage) || pagination.maxPage < pagination.initial)) failContract();
  } else failContract();
  const query = input.query ?? {};
  if (!isRecord(query) || Object.keys(query).length > 30) failContract();
  const normalizedQuery = {};
  for (const [key, value] of Object.entries(query)) {
    queryName(key);
    if (key === input.pageSizeParam || key === pagination.parameter) failContract();
    normalizedQuery[key] = queryValue(value);
  }
  const timeoutMs = input.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) failContract();
  return { ...input, query: normalizedQuery, timeoutMs };
}

function readPath(object, path) {
  if (!path) return undefined;
  return path.split('.').reduce((value, part) => value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined, object);
}

function invalidResponse() {
  return new ChangduCatalogError('changdu_response_invalid', '常读返回的数据与已配置的只读协议不符，未推进同步进度。');
}

function identifier(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n && String(value).length <= 128) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  throw invalidResponse();
}

function dateOrNull(value) {
  // Numeric epochs are intentionally not guessed as seconds or milliseconds.
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sourceUrlOrNull(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function normalizeItem(row, fields) {
  if (!isRecord(row)) throw invalidResponse();
  const value = name => readPath(row, fields[name]);
  const title = value('title');
  if (typeof title !== 'string' || !title.trim() || title.length > 1000) throw invalidResponse();
  const episodes = value('episodeCount');
  const rawStatus = value('releaseStatus');
  const mode = value('businessMode');
  return {
    externalId: identifier(value('externalId')),
    title: title.trim(),
    episodeCount: Number.isSafeInteger(episodes) && episodes >= 0 ? episodes : null,
    releaseStatus: ['string', 'number', 'boolean'].includes(typeof rawStatus) && String(rawStatus).length <= 256 ? String(rawStatus) : '',
    publishedAt: dateOrNull(value('publishedAt')),
    sourceUpdatedAt: dateOrNull(value('sourceUpdatedAt')),
    businessMode: mode === 'paid' || mode === 'free' ? mode : 'unknown',
    sourceUrl: sourceUrlOrNull(value('sourceUrl')),
  };
}

function cursorValue(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  throw invalidResponse();
}

function nextPage(body, contract, current, rowCount, expectedTotal) {
  const pagination = contract.pagination;
  if (pagination.totalPath !== undefined) {
    const total = readPath(body, pagination.totalPath);
    const offset = (Number(current) - pagination.initial) * contract.pageSize;
    if (!Number.isSafeInteger(total) || total < 0) throw invalidResponse();
    if (expectedTotal !== null && total !== expectedTotal) {
      throw new ChangduCatalogError('changdu_total_changed', '常读剧库总量在分页期间发生变化，本次未推进进度；请重新开始全量同步。', { status: 409 });
    }
    if (!Number.isSafeInteger(offset) || offset > total || (offset === total && offset !== 0)) throw invalidResponse();
    if (pagination.maxPage !== undefined && total > (pagination.maxPage - pagination.initial + 1) * contract.pageSize) throw invalidResponse();
    // A short or empty page before the declared end cannot be treated as completion.
    if (rowCount !== Math.min(contract.pageSize, total - offset)) throw invalidResponse();
    const hasMore = offset + rowCount < total;
    const next = Number(current) + 1;
    if (hasMore && (!Number.isSafeInteger(next) || (pagination.maxPage !== undefined && next > pagination.maxPage))) throw invalidResponse();
    return { hasMore, nextCursor: hasMore ? `changdu-total-v1:${next}:${total}` : null, snapshotTotal: total };
  }
  const hasMore = readPath(body, contract.pagination.hasMorePath);
  if (typeof hasMore !== 'boolean') throw invalidResponse();
  if (!hasMore) return { hasMore: false, nextCursor: null };
  const nextCursor = contract.pagination.type === 'cursor'
    ? cursorValue(readPath(body, contract.pagination.nextPath))
    : String(Number(current) + 1);
  if (nextCursor === current || (contract.pagination.type === 'page' && (!Number.isSafeInteger(Number(nextCursor)) ||
      (pagination.maxPage !== undefined && Number(nextCursor) > pagination.maxPage)))) throw invalidResponse();
  return { hasMore, nextCursor };
}

function safeRetryAfter(response, now) {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now();
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600000) : undefined;
}

function cancelResponse(response) {
  try { response?.body?.cancel()?.catch(() => {}); } catch { /* Already locked or closed. */ }
}

async function boundedJson(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    cancelResponse(response);
    throw new ChangduCatalogError('changdu_response_too_large', '常读单页响应超过 2 MiB，已停止读取。');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw invalidResponse();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ChangduCatalogError('changdu_timeout', '常读接口响应超时，可稍后重试。', { status: 504, retryable: true });
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        cancel();
        throw new ChangduCatalogError('changdu_response_too_large', '常读单页响应超过 2 MiB，已停止读取。');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return parseChangduJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw invalidResponse(); }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** No retries or page traversal here: the persistent sync worker owns pacing and checkpoints. */
export function createChangduCatalogAdapter({ env = {}, fetcher = fetch, now = Date.now } = {}) {
  let contract;
  let configError;
  try { contract = readContract(env.CHANGDU_CATALOG_CONTRACT); }
  catch (error) { configError = error instanceof ChangduCatalogError ? error : new ChangduCatalogError('changdu_contract_invalid', '常读只读接口协议配置无效。', { status: 503 }); }

  return {
    configuration() {
      return { configured: Boolean(contract), reason: contract ? (env.CHANGDU_CATALOG_CONTRACT === undefined
        ? '已内置常读端原生剧目只读协议，尚需验证账户权限和连接。'
        : '只读接口协议已配置，尚需验证账户连接。') : configError.message };
    },
    async fetchPage({ distributorId, secretKey, cursor = null } = {}) {
      if (!contract) throw configError;
      if (typeof distributorId !== 'string' || !/^[0-9]{1,40}$/.test(distributorId) || typeof secretKey !== 'string' || !secretKey.length || secretKey.length > 2048 || /[\u0000-\u001f\u007f]/.test(secretKey)) {
        throw new ChangduCatalogError('changdu_credentials_missing', '请配置有效的常读分销商标识和签名密钥。', { status: 400 });
      }
      let current, expectedTotal = null;
      if (cursor === null) current = String(contract.pagination.initial);
      else if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 512 && !/[\u0000-\u001f\u007f]/.test(cursor)) current = cursor;
      else throw new ChangduCatalogError('changdu_cursor_invalid', '常读同步游标无效。', { status: 400 });
      if (contract.pagination.totalPath !== undefined && current.startsWith('changdu-total-v1:')) {
        const parts = /^changdu-total-v1:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(current);
        if (!parts || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) <= 0) {
          throw new ChangduCatalogError('changdu_cursor_invalid', '常读同步快照游标无效。', { status: 400 });
        }
        current = parts[1];
        expectedTotal = Number(parts[2]);
        const offset = (Number(current) - contract.pagination.initial) * contract.pageSize;
        if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= expectedTotal ||
            (contract.pagination.maxPage !== undefined && expectedTotal > (contract.pagination.maxPage - contract.pagination.initial + 1) * contract.pageSize)) {
          throw new ChangduCatalogError('changdu_cursor_invalid', '常读同步快照游标无效。', { status: 400 });
        }
      }
      if (contract.pagination.type === 'page' && (!/^(0|[1-9][0-9]*)$/.test(current) || !Number.isSafeInteger(Number(current)) ||
          Number(current) < contract.pagination.initial || (contract.pagination.maxPage !== undefined && Number(current) > contract.pagination.maxPage))) {
        throw new ChangduCatalogError('changdu_cursor_invalid', '常读同步页码无效。', { status: 400 });
      }
      const query = { ...contract.query, distributor_id: distributorId, [contract.pageSizeParam]: String(contract.pageSize), [contract.pagination.parameter]: current };
      const sorted = Object.keys(query).sort();
      const ts = String(Math.floor(now() / 1000));
      const signature = createHash('md5').update(distributorId + secretKey + ts + sorted.map(key => query[key] + '|').join(''), 'utf8').digest('hex');
      const url = new URL(contract.path, ORIGIN);
      for (const key of sorted) url.searchParams.set(key, query[key]);
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ChangduCatalogError('changdu_timeout', '常读接口响应超时，可稍后重试。', { status: 504, retryable: true }));
          controller.abort();
        }, contract.timeoutMs);
      });
      const request = async () => {
        const response = await fetcher(url.href, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { accept: 'application/json', 'header-ts': ts, 'header-sign': signature },
        });
        if (controller.signal.aborted) { cancelResponse(response); throw new ChangduCatalogError('changdu_timeout', '常读接口响应超时，可稍后重试。', { status: 504, retryable: true }); }
        if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && new URL(response.url).origin !== ORIGIN)) {
          cancelResponse(response);
          throw new ChangduCatalogError('changdu_redirect_refused', '常读接口返回了未允许的跳转，已停止请求。');
        }
        if (!response.ok) {
          cancelResponse(response);
          if (response.status === 401 || response.status === 403) throw new ChangduCatalogError('changdu_auth_failed', '常读账户授权失败，请检查分销商标识和签名密钥。', { status: 401 });
          if (response.status === 429) throw new ChangduCatalogError('changdu_rate_limited', '常读接口限流，请降低同步频率。', { status: 429, retryable: true, retryAfterMs: safeRetryAfter(response, now) });
          throw new ChangduCatalogError('changdu_http_error', '常读只读接口暂未返回有效响应。', { retryable: response.status >= 500 });
        }
        const body = await boundedJson(response, controller.signal);
        if (!isRecord(body)) throw invalidResponse();
        if ([410, 411, 412].includes(body.code)) throw new ChangduCatalogError('changdu_auth_failed', '常读分销商标识、签名或时间戳验证失败，请检查配置。', { status: 401 });
        if (body.code === 413) throw new ChangduCatalogError('changdu_api_not_enabled', '常读账号尚未开通此接口权限，请联系常读商务确认端原生剧目接口授权。', { status: 403 });
        if (body.code === 500) throw new ChangduCatalogError('changdu_rate_limited', '常读接口限流，请降低同步频率。', { status: 429, retryable: true, retryAfterMs: safeRetryAfter(response, now) });
        if (body.code === 501) throw new ChangduCatalogError('changdu_upstream_error', '常读服务暂时不可用，可稍后重试。', { retryable: true });
        if (body.code !== 200) throw invalidResponse();
        const rows = readPath(body, contract.itemsPath);
        if (!Array.isArray(rows) || rows.length > contract.pageSize) throw invalidResponse();
        const page = nextPage(body, contract, current, rows.length, expectedTotal);
        if (page.hasMore && rows.length === 0) throw invalidResponse();
        const items = rows.map(row => normalizeItem(row, contract.fields));
        if (new Set(items.map(item => item.externalId)).size !== items.length) throw invalidResponse();
        return { items, ...page };
      };
      try { return await Promise.race([request(), timeout]); }
      catch (error) {
        if (error instanceof ChangduCatalogError) throw error;
        throw new ChangduCatalogError('changdu_network_error', '常读接口连接失败，可稍后重试。', { retryable: true });
      } finally { clearTimeout(timer); }
    },
  };
}
