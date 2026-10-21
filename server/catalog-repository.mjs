const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);
const gateKey = 'changdu:catalog';

/** Every source and item query is tenant scoped; only the interface throttle is shared. */
export function createCatalogRepository(DB) {
  if (!DB?.prepare) throw Object.assign(new Error('抓取数据库未配置'), { status: 503, code: 'catalog_storage_unavailable' });
  const query = (sql, ...args) => DB.prepare(sql).bind(...args);
  const get = userId => query("SELECT * FROM catalogSources WHERE userId=? AND provider='changdu'", userId).first();
  const fenced = 'id=? AND userId=? AND version=? AND leaseToken=? AND leaseUntil>?';
  const fenceArgs = (source, now) => [source.id, source.userId, source.version, source.leaseToken, now];
  async function update(userId, id, version, patch) {
    const keys = Object.keys(patch);
    return changes(await query(`UPDATE catalogSources SET ${keys.map(key => `${key}=?`).join(',')} WHERE userId=? AND id=? AND version=?`, ...keys.map(key => patch[key]), userId, id, version).run());
  }
  return {
    get, update,
    async insert(source) {
      const keys = Object.keys(source);
      return changes(await query(`INSERT INTO catalogSources (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT(userId,provider) DO NOTHING`, ...keys.map(key => source[key])).run());
    },
    async claim(source, now, leaseUntil, token) {
      const result = await query(`UPDATE catalogSources SET leaseToken=?,leaseUntil=?,runStatus='running',updatedAt=?
        WHERE id=? AND userId=? AND version=? AND runStatus IN ('queued','waiting','running')
        AND (nextRequestAt IS NULL OR nextRequestAt<=?) AND (leaseToken IS NULL OR leaseUntil<=?)`,
      token, leaseUntil, now, source.id, source.userId, source.version, now, now).run();
      return changes(result) ? { ...source, leaseToken: token, leaseUntil, runStatus: 'running' } : null;
    },
    async reserveRequest(now, until) {
      const result = await query(`INSERT INTO catalogThrottle (key,nextRequestAt) VALUES (?,?) ON CONFLICT(key)
        DO UPDATE SET nextRequestAt=excluded.nextRequestAt WHERE catalogThrottle.nextRequestAt<=?`, gateKey, until, now).run();
      return { acquired: changes(result) > 0, nextRequestAt: (await query('SELECT nextRequestAt FROM catalogThrottle WHERE key=?', gateKey).first()).nextRequestAt };
    },
    async deferGlobal(until) {
      await query('UPDATE catalogThrottle SET nextRequestAt=? WHERE key=? AND nextRequestAt<?', until, gateKey, until).run();
    },
    async finishAttempt(source, now, patch) {
      const fields = { ...patch, leaseToken: null, leaseUntil: null, updatedAt: now };
      const keys = Object.keys(fields);
      return changes(await query(`UPDATE catalogSources SET ${keys.map(key => `${key}=?`).join(',')} WHERE ${fenced}`, ...keys.map(key => fields[key]), ...fenceArgs(source, now)).run());
    },
    async commitPage(source, items, checkpoint, now) {
      if (typeof DB.batch !== 'function') throw Object.assign(new Error('抓取存储不支持原子批处理'), { status: 503, code: 'catalog_atomic_storage_required' });
      const wanted = JSON.stringify(items.map(item => ({ businessMode: item.businessMode, externalId: item.externalId })));
      const prior = (await query(`SELECT i.externalId,i.businessMode,i.metadataHash,i.lastSeenAt FROM json_each(?) w JOIN catalogItems i
        ON i.userId=? AND i.sourceId=? AND i.businessMode=json_extract(w.value,'$.businessMode')
        AND i.externalId=json_extract(w.value,'$.externalId')`, wanted, source.userId, source.id).all()).results || [];
      if (checkpoint.seenAfter !== undefined && source.pages > 0 && prior.some(item => item.lastSeenAt > checkpoint.seenAfter))
        throw Object.assign(new Error('Catalog changed during scan'), { status: 409, code: 'catalog_snapshot_changed' });
      // Keep scan watermarks distinct even when two scans commit in the same millisecond.
      // Lease fences always use actual time, not this monotonically increasing data timestamp.
      const stamp = new Date(Math.max(Date.parse(now), (Date.parse(source.lastSuccessAt || '') || 0) + 1)).toISOString();
      const existing = new Map(prior.map(item => [JSON.stringify([item.businessMode, item.externalId]), item.metadataHash]));
      let inserted = 0, updated = 0;
      for (const item of items) {
        const key = JSON.stringify([item.businessMode, item.externalId]);
        if (!existing.has(key)) inserted++; else if (existing.get(key) !== item.metadataHash) updated++;
      }
      const payload = JSON.stringify(items.map(item => ({ ...item, id: crypto.randomUUID() })));
      // One bound JSON payload avoids a separate database statement or bind per record.
      const statements = [query(`INSERT INTO catalogItems (id,userId,sourceId,externalId,businessMode,title,episodeCount,releaseStatus,publishedAt,sourceUpdatedAt,sourceUrl,metadataHash,lastSeenAt,createdAt,updatedAt)
          SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.externalId'),json_extract(value,'$.businessMode'),json_extract(value,'$.title'),
          json_extract(value,'$.episodeCount'),json_extract(value,'$.releaseStatus'),json_extract(value,'$.publishedAt'),json_extract(value,'$.sourceUpdatedAt'),
          json_extract(value,'$.sourceUrl'),json_extract(value,'$.metadataHash'),?,?,? FROM json_each(?)
          WHERE EXISTS(SELECT 1 FROM catalogSources WHERE ${fenced})
          ON CONFLICT(userId,sourceId,businessMode,externalId) DO UPDATE SET title=excluded.title,episodeCount=excluded.episodeCount,
          releaseStatus=excluded.releaseStatus,publishedAt=excluded.publishedAt,sourceUpdatedAt=excluded.sourceUpdatedAt,
          sourceUrl=excluded.sourceUrl,metadataHash=excluded.metadataHash,lastSeenAt=excluded.lastSeenAt,updatedAt=excluded.updatedAt`,
      source.userId, source.id, stamp, stamp, stamp, payload, ...fenceArgs(source, now))];
      statements.push(query(`UPDATE catalogSources SET cursor=?,cursorHistory=?,runStatus=?,processed=processed+?,inserted=inserted+?,updated=updated+?,pages=pages+1,
        retryCount=0,nextRequestAt=?,finishedAt=?,lastSuccessAt=?,lastError=NULL,connectionStatus='verified',leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE ${fenced}`,
      checkpoint.cursor, checkpoint.cursorHistory, checkpoint.status, items.length, inserted, updated, checkpoint.nextRequestAt, checkpoint.finishedAt, stamp, now, ...fenceArgs(source, now)));
      // D1 batch is transactional. Every write repeats the same lease fence, including the checkpoint.
      const results = await DB.batch(statements);
      return changes(results.at(-1)) > 0;
    },
    async due(now, limit) {
      return (await query(`SELECT * FROM catalogSources WHERE provider='changdu' AND (
        (runStatus IN ('queued','waiting','running') AND (nextRequestAt IS NULL OR nextRequestAt<=?) AND (leaseToken IS NULL OR leaseUntil<=?))
        OR (runStatus='completed' AND autoSync=1 AND nextRequestAt<=?))
        ORDER BY COALESCE(lastSuccessAt,createdAt),COALESCE(nextRequestAt,createdAt),id LIMIT ?`, now, now, now, limit).all()).results || [];
    },
    async nextDue() {
      return (await query(`SELECT min(CASE WHEN leaseUntil IS NOT NULL AND leaseUntil>COALESCE(nextRequestAt,createdAt) THEN leaseUntil ELSE COALESCE(nextRequestAt,createdAt) END) AS at
        FROM catalogSources WHERE provider='changdu' AND (runStatus IN ('queued','waiting','running') OR (runStatus='completed' AND autoSync=1))`).first())?.at || null;
    },
    async list(userId, sourceId, { q, after, limit }) {
      let where = 'userId=? AND sourceId=?';
      const params = [userId, sourceId];
      // instr keeps long Chinese titles valid under D1's small LIKE-pattern byte limit.
      if (q) { where += ' AND (instr(lower(title),lower(?))>0 OR externalId=?)'; params.push(q, q); }
      const total = Number((await query(`SELECT count(*) AS total FROM catalogItems WHERE ${where}`, ...params).first()).total);
      if (after) { where += ' AND (createdAt<? OR (createdAt=? AND id<?))'; params.push(after.createdAt, after.createdAt, after.id); }
      const rows = (await query(`SELECT id,externalId,title,episodeCount,releaseStatus,publishedAt,sourceUpdatedAt,businessMode,lastSeenAt,createdAt
        FROM catalogItems WHERE ${where} ORDER BY createdAt DESC,id DESC LIMIT ?`, ...params, limit + 1).all()).results || [];
      return { rows, total };
    }
  };
}
