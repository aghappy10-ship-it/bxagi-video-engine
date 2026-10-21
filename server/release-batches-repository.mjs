/** Batch preparation is local account data, never an employee dispatch queue. */
const TYPE = 'release_batch';
const decode = row => row ? { ...row, details: JSON.parse(row.details) } : null;
const chunks = values => Array.from({ length: Math.ceil(values.length / 80) }, (_, i) => values.slice(i * 80, i * 80 + 80));

export function createReleaseBatchRepository(DB) {
  const query = (sql, ...args) => DB.prepare(sql).bind(...args);
  const get = async (userId, id) => decode(await query('SELECT * FROM jobs WHERE userId = ? AND id = ? AND type = ?', userId, id, TYPE).first());
  return {
    get,
    async list(userId) {
      return ((await query('SELECT * FROM jobs WHERE userId = ? AND type = ? ORDER BY createdAt DESC, id DESC LIMIT 20', userId, TYPE).all()).results || []).map(decode);
    },
    async update(userId, id, revision, details) {
      const serialized = JSON.stringify(details);
      // A D1 row has a finite byte budget; reject oversized batches before writing.
      if (new TextEncoder().encode(serialized).byteLength > 1024 * 1024) throw Object.assign(new Error('批次内容超过 1 MiB，请缩短链接或拆分批次'), { status: 413, code: 'release_batch_too_large' });
      const result = await query("UPDATE jobs SET details = ?, updatedAt = ? WHERE userId = ? AND id = ? AND type = ? AND json_extract(details, '$.revision') = ?", serialized, new Date().toISOString(), userId, id, TYPE, revision).run();
      return Number(result.meta?.changes ?? result.changes ?? 0) > 0 ? get(userId, id) : null;
    },
    async projectFacts(userId, projectIds) {
      const projects = new Map(), creatives = [], jobs = [];
      // Chunked owner-scoped queries avoid one request per drama/creative and D1 bind limits.
      for (const ids of chunks([...new Set(projectIds.filter(Boolean))])) {
        const placeholders = ids.map(() => '?').join(',');
        const rows = await query(`SELECT id,sourceState FROM projects WHERE userId = ? AND id IN (${placeholders})`, userId, ...ids).all();
        for (const project of rows.results || []) projects.set(project.id, { id: project.id, sourceCount: 0, sourceState: JSON.parse(project.sourceState) });
        const sources = await query(`SELECT projectId, count(*) AS count FROM assets WHERE userId = ? AND projectId IN (${placeholders}) AND status = 'uploaded' AND size > 0 AND objectKey != '' GROUP BY projectId`, userId, ...ids).all();
        for (const source of sources.results || []) if (projects.has(source.projectId)) projects.get(source.projectId).sourceCount = Number(source.count);
        const outputs = await query(`SELECT id,userId,projectId,filename,mimeType,size,objectKey,validation,status,metadata FROM creatives WHERE userId = ? AND projectId IN (${placeholders}) AND size > 0 AND objectKey != '' AND status != 'rejected'`, userId, ...ids).all();
        for (const creative of outputs.results || []) creatives.push({ ...creative, metadata: JSON.parse(creative.metadata) });
      }
      const jobIds = [...new Set(creatives.map(row => row.metadata?.sourceJobId).filter(value => typeof value === 'string' && value.length > 0 && value.length <= 160))];
      for (const ids of chunks(jobIds)) {
        const rows = await query(`SELECT * FROM jobs WHERE userId = ? AND id IN (${ids.map(() => '?').join(',')})`, userId, ...ids).all();
        jobs.push(...(rows.results || []).map(decode));
      }
      return { projects, creatives, jobs };
    }
  };
}
