import { createCatalogRepository } from './catalog-repository.mjs';
import { createChangduCatalogAdapter } from './adapters/changdu-catalog.mjs';
import { encryptConnectionSecrets, decryptConnectionSecrets } from './adapters/connection-secrets.mjs';
import { backgroundSchedulerHealth } from './background-scheduler.mjs';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const iso = milliseconds => new Date(milliseconds).toISOString();
const active = ['queued', 'running', 'waiting'];
const SNAPSHOT_CHANGED = '上游剧库在分页期间发生变化或返回重复剧目，已停止；点击继续将从第一页重新扫描';
const ownKeys = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'catalog_invalid_input', '抓取参数不合法');
};
const textValue = (value, min, max, name) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u001f]/.test(value)) fail(400, 'catalog_invalid_input', `${name}格式不正确`);
  return value.trim();
};
const resetRun = { cursor: null, cursorHistory: '[]', processed: 0, inserted: 0, updated: 0, pages: 0, retryCount: 0, finishedAt: null };
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

/** Fast local reads and durable, bounded upstream page work are separate operations. */
export function createCatalogService({ env = {}, fetcher = fetch, now = Date.now, adapter: injectedAdapter,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const store = createCatalogRepository(env.DB);
  const adapter = injectedAdapter || createChangduCatalogAdapter({ env, fetcher, now });
  const sourceRequired = source => source || fail(409, 'catalog_source_required', '请先配置常读分销商标识和签名密钥');
  const configured = () => { const config = adapter.configuration(); if (!config.configured) fail(503, 'catalog_integration_unconfigured', config.reason); return config; };
  const status = async userId => {
    const [source, scheduler] = await Promise.all([store.get(userId), backgroundSchedulerHealth(env, now())]);
    return {
      source: { configured: !!source, label: source?.label || '', distributorId: source?.distributorId || '', autoSync: !!source?.autoSync,
        connectionStatus: source?.connectionStatus || 'unconfigured', lastSuccessAt: source?.lastSuccessAt || null, lastError: source?.lastError || null },
      integration: adapter.configuration(),
      run: source?.runStatus ? { status: source.runStatus, processed: source.processed, inserted: source.inserted, updated: source.updated,
        pages: source.pages, nextRunAt: source.nextRequestAt, error: source.lastError, startedAt: source.startedAt, finishedAt: source.finishedAt } : null,
      scheduler: { running: scheduler.status === 'running', status: scheduler.status }
    };
  };
  async function saveSource(userId, body) {
    ownKeys(body, ['label', 'distributorId', 'secretKey', 'autoSync']);
    const label = textValue(body.label, 1, 80, '数据源名称');
    const distributorId = textValue(body.distributorId, 1, 40, '分销商标识');
    if (!/^\d+$/.test(distributorId) || typeof body.autoSync !== 'boolean') fail(400, 'catalog_invalid_input', '分销商标识或自动同步设置不正确');
    const prior = await store.get(userId), accountChanged = prior && prior.distributorId !== distributorId;
    const secretKey = body.secretKey === undefined || body.secretKey === '' ? null : body.secretKey;
    if (secretKey !== null && (typeof secretKey !== 'string' || !secretKey.trim() || secretKey.length > 2048 || /[\u0000-\u001f]/.test(secretKey))) fail(400, 'catalog_invalid_input', '签名密钥格式不正确');
    if ((!prior || accountChanged) && !secretKey) fail(400, 'catalog_secret_required', '首次配置或切换分销商时需要签名密钥');
    const changed = !prior || accountChanged || !!secretKey;
    const ciphertext = secretKey ? await encryptConnectionSecrets({ secretKey }, env.APP_ENCRYPTION_KEY) : prior.secretsCiphertext;
    const time = iso(now());
    const patch = { label, distributorId, secretsCiphertext: ciphertext, autoSync: Number(body.autoSync), updatedAt: time };
    let saved;
    if (!prior) saved = await store.insert({ ...patch, id: crypto.randomUUID(), userId, provider: 'changdu', createdAt: time });
    else {
      Object.assign(patch, { version: prior.version + 1, leaseToken: null, leaseUntil: null });
      if (changed) Object.assign(patch, resetRun, { connectionStatus: 'pending', lastSuccessAt: null, lastError: null, runStatus: null, startedAt: null, nextRequestAt: null });
      else if (prior.runStatus === 'running') patch.runStatus = 'queued';
      if (!body.autoSync && prior.runStatus === 'completed') patch.nextRequestAt = null;
      if (!changed && body.autoSync && prior.runStatus === 'completed' && !prior.nextRequestAt) patch.nextRequestAt = iso(now() + 60000);
      if (accountChanged) patch.id = crypto.randomUUID(); // Previous account records remain preserved but are no longer listed.
      saved = await store.update(userId, prior.id, prior.version, patch);
    }
    if (!saved) fail(409, 'catalog_source_conflict', '数据源刚被其他操作更新，请刷新后重试');
    return status(userId);
  }
  async function start(userId) {
    configured();
    const source = sourceRequired(await store.get(userId));
    if (active.includes(source.runStatus)) return status(userId); // Preserve retry and rate-limit deadlines.
    const time = iso(now()), fresh = !source.runStatus || source.runStatus === 'completed' || source.lastError === SNAPSHOT_CHANGED;
    const patch = { ...(fresh ? resetRun : {}), runStatus: 'queued', version: source.version + 1,
      leaseToken: null, leaseUntil: null, lastError: null, retryCount: 0, startedAt: fresh ? time : source.startedAt || time,
      finishedAt: null, nextRequestAt: time, updatedAt: time };
    if (!await store.update(userId, source.id, source.version, patch)) fail(409, 'catalog_source_conflict', '抓取状态已更新，请刷新后重试');
    return status(userId);
  }
  async function pause(userId) {
    const source = sourceRequired(await store.get(userId));
    if (!await store.update(userId, source.id, source.version, { runStatus: 'paused', version: source.version + 1, leaseToken: null,
      leaseUntil: null, nextRequestAt: null, updatedAt: iso(now()) })) fail(409, 'catalog_source_conflict', '抓取状态已更新，请刷新后重试');
    return status(userId);
  }
  async function validatePage(page, cursor) {
    const invalid = () => fail(502, 'catalog_invalid_page', '常读接口返回的数据不符合已配置字段，请检查接口契约');
    if (!page || !Array.isArray(page.items) || page.items.length > 100 || typeof page.hasMore !== 'boolean' ||
      (page.hasMore && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === cursor || page.nextCursor.length > 2048))) invalid();
    const unique = new Map();
    for (const row of page.items) {
      if (!row || typeof row.externalId !== 'string' || !row.externalId || row.externalId.length > 256 || typeof row.title !== 'string' || !row.title || row.title.length > 1000 ||
        !['paid', 'free', 'unknown'].includes(row.businessMode) || typeof row.releaseStatus !== 'string' || row.releaseStatus.length > 256 ||
        !(row.episodeCount === null || Number.isInteger(row.episodeCount) && row.episodeCount >= 0) ||
        ![row.publishedAt, row.sourceUpdatedAt].every(value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value)))) invalid();
      const item = { externalId: row.externalId, title: row.title, episodeCount: row.episodeCount, releaseStatus: row.releaseStatus,
        publishedAt: row.publishedAt, sourceUpdatedAt: row.sourceUpdatedAt, businessMode: row.businessMode, sourceUrl: row.sourceUrl ?? null };
      if (item.sourceUrl !== null && (typeof item.sourceUrl !== 'string' || item.sourceUrl.length > 4096)) invalid();
      item.metadataHash = await hash(JSON.stringify(item));
      unique.set(JSON.stringify([item.businessMode, item.externalId]), item);
    }
    return [...unique.values()];
  }
  async function work(userId) {
    configured();
    const source = sourceRequired(await store.get(userId));
    if (!active.includes(source.runStatus)) return false;
    const claimTime = now();
    const claimed = await store.claim(source, iso(claimTime), iso(claimTime + 30000), crypto.randomUUID());
    if (!claimed) return false;
    try {
      if (claimed.pages >= 10000) fail(502, 'catalog_pagination_limit', '分页数量超过安全上限，已停止并保留断点');
      const secrets = await decryptConnectionSecrets(claimed.secretsCiphertext, env.APP_ENCRYPTION_KEY);
      const time = now(), gate = await store.reserveRequest(iso(time), iso(time + 1000));
      if (!gate.acquired) { await store.finishAttempt(claimed, iso(now()), { runStatus: 'waiting', nextRequestAt: gate.nextRequestAt }); return false; }
      const page = await adapter.fetchPage({ distributorId: claimed.distributorId, secretKey: secrets.secretKey, cursor: claimed.cursor });
      const items = await validatePage(page, claimed.cursor), finished = now();
      const savedHistory = JSON.parse(claimed.cursorHistory || '[]');
      const history = Array.isArray(savedHistory) ? savedHistory : savedHistory.cursorHashes;
      const strictScan = Number.isSafeInteger(page.snapshotTotal);
      let seenAfter;
      if (strictScan) {
        seenAfter = claimed.pages === 0 ? claimed.lastSuccessAt || iso(0) : savedHistory.seenAfter;
        if (typeof seenAfter !== 'string' || !Number.isFinite(Date.parse(seenAfter)) || items.length !== page.items.length)
          fail(409, 'catalog_snapshot_changed', SNAPSHOT_CHANGED);
      }
      if (page.hasMore) {
        const nextHash = await hash(page.nextCursor);
        if (history.includes(nextHash)) fail(502, 'catalog_cursor_cycle', '接口重复返回已访问的游标，已停止并保留断点');
        history.push(nextHash);
      }
      const cursorHistory = strictScan ? { cursorHashes: history.slice(-128), seenAfter } : history.slice(-128);
      return await store.commitPage(claimed, items, { cursor: page.hasMore ? page.nextCursor : null, cursorHistory: JSON.stringify(cursorHistory), seenAfter, status: page.hasMore ? 'waiting' : 'completed',
        nextRequestAt: page.hasMore ? iso(Math.max(finished, time + 1000)) : claimed.autoSync ? iso(finished + 60000) : null,
        finishedAt: page.hasMore ? null : iso(finished) }, iso(finished));
    } catch (error) {
      const count = claimed.retryCount + 1, retry = error?.retryable === true && count <= 5;
      const delay = Math.max(Math.min(300000, 2000 * (2 ** (count - 1))), Math.min(3600000, Number(error?.retryAfterMs) || 0));
      const nextRequestAt = retry ? iso(now() + delay) : null;
      // Never persist upstream response bodies, request URLs, credentials, or arbitrary exception text.
      const message = retry ? '上游暂不可用，已保留断点并等待重试' :
        ['changdu_total_changed', 'catalog_snapshot_changed'].includes(error?.code) ? SNAPSHOT_CHANGED :
        error?.code === 'changdu_api_not_enabled' ? '常读尚未开通此账号的剧目接口，请联系常读商务开通' :
        error?.code === 'changdu_auth_failed' ? '常读签名验证失败，请检查分销商标识、密钥与账号权限' :
        error?.code === 'changdu_response_invalid' ? '常读响应字段或分页总数异常，已停止并保留断点' :
        error?.code === 'catalog_cursor_cycle' ? '接口重复返回已访问的游标，已停止并保留断点' :
        error?.code === 'catalog_pagination_limit' ? '分页数量超过 10000 页，已停止并保留断点' : error?.code === 'catalog_invalid_page' ? '接口字段异常，已停止并保留断点' :
        error?.retryable === true ? '上游连续失败，已停止并保留断点' : '抓取未完成，请检查接口契约、授权和密钥配置';
      // Exhausting this source's retries does not cancel an upstream-wide Retry-After.
      if (error?.retryable === true) await store.deferGlobal(iso(now() + delay));
      await store.finishAttempt(claimed, iso(now()), { runStatus: retry ? 'waiting' : 'failed', retryCount: count, nextRequestAt,
        lastError: message, connectionStatus: 'error', finishedAt: retry ? null : iso(now()) });
      return false;
    }
  }
  async function resumeAutomatic(userId) {
    const source = await store.get(userId);
    if (source?.runStatus === 'completed' && source.autoSync && source.nextRequestAt && source.nextRequestAt <= iso(now())) {
      // Retain the completed snapshot's version: a concurrent pause/configuration update wins.
      const time = iso(now());
      await store.update(userId, source.id, source.version, { ...resetRun, runStatus: 'queued', version: source.version + 1,
        leaseToken: null, leaseUntil: null, lastError: null, startedAt: time, nextRequestAt: time, updatedAt: time });
    }
  }
  async function advance(userId) { await resumeAutomatic(userId); await work(userId); return status(userId); }
  async function list(userId, input = {}) {
    ownKeys(input, ['q', 'cursor', 'limit']);
    const started = performance.now(), source = await store.get(userId);
    const q = input.q === undefined || input.q === '' ? '' : textValue(input.q, 1, 100, '搜索词');
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'catalog_invalid_input', '每页数量必须为 1–100');
    let after = null;
    if (input.cursor) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 4096) throw new Error();
        const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(input.cursor), c => c.charCodeAt(0))));
        if (parsed.v !== 1 || parsed.sourceId !== source?.id || parsed.q !== q || typeof parsed.id !== 'string' || parsed.id.length > 100 || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error();
        after = parsed;
      } catch { fail(400, 'catalog_invalid_cursor', '分页已变化，请从第一页重新查询'); }
    }
    if (!source) return { items: [], total: 0, nextCursor: null, queryMs: Math.round((performance.now() - started) * 100) / 100 };
    const result = await store.list(userId, source.id, { q, after, limit });
    const selected = result.rows.slice(0, limit), last = selected.at(-1);
    const nextCursor = result.rows.length > limit ? btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ v: 1, sourceId: source.id, q, createdAt: last.createdAt, id: last.id })))) : null;
    return { items: selected.map(row => { const item = { ...row }; delete item.createdAt; return item; }), total: result.total, nextCursor, queryMs: Math.round((performance.now() - started) * 100) / 100 };
  }
  async function tick({ limit = 1 } = {}) {
    if (!adapter.configuration().configured) return { processed: 0, skipped: 'integration_unconfigured' };
    const maxPages = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 1))), deadline = performance.now() + 25000;
    let processed = 0, attempts = 0;
    while (processed < maxPages && attempts < maxPages * 3 && performance.now() < deadline - 8500) {
      // The least recently advanced due source wins, so one account cannot monopolize the queue.
      const sources = await store.due(iso(now()), 1);
      if (!sources.length) {
        if (maxPages === 1) break;
        const nextDue = await store.nextDue(), waitMs = nextDue ? Date.parse(nextDue) - now() : Infinity;
        if (waitMs <= 0 || waitMs > 1000) break;
        await wait(waitMs);
        continue;
      }
      attempts++;
      const source = sources[0];
      await resumeAutomatic(source.userId);
      if (await work(source.userId)) processed++;
      if (maxPages === 1) break;
    }
    return { processed };
  }
  return { status, saveSource, start, advance, pause, list, tick };
}
