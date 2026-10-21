const ID = 'platform-background-scheduler';
const OWNER = 'system:background-scheduler';
const TYPE = 'platform_background_health';
export const SCHEDULER_STALE_MS = 180000;
const LEASE_MS = 10 * 60 * 1000;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const query = (DB, sql, ...args) => DB.prepare(sql).bind(...args);

async function read(DB) {
  if (!DB?.prepare) return null;
  const row = await query(DB, 'SELECT status,details FROM jobs WHERE id = ? AND userId = ? AND type = ?', ID, OWNER, TYPE).first();
  if (!row) return null;
  try { return { status: row.status, ...JSON.parse(row.details) }; } catch { return null; }
}

/** A configured flag alone never proves that a scheduler is running. */
export async function backgroundSchedulerHealth(env = {}, now = Date.now()) {
  const configured = env.BXAGI_BACKGROUND_ENABLED === 'true';
  let record;
  try { record = await read(env.DB); } catch { record = null; }
  const lastAttemptAt = timestamp(record?.lastAttemptAt);
  const lastSuccessfulTickAt = timestamp(record?.lastSuccessfulTickAt);
  const age = lastSuccessfulTickAt ? now - Date.parse(lastSuccessfulTickAt) : Infinity;
  const recent = age >= 0 && age < SCHEDULER_STALE_MS;
  const status = !configured ? 'disabled' : record?.status === 'error' ? 'error' : recent ? 'running' : lastAttemptAt ? 'stalled' : 'unverified';
  return { configured, status, lastAttemptAt, lastSuccessfulTickAt, staleAfterMs: SCHEDULER_STALE_MS,
    lastErrorCode: record?.status === 'error' ? 'background_tick_incomplete' : null };
}

/** Fenced global lease; work retains its own tenant/job leases and write guards. */
export async function runBackgroundTick({ env, work, now = () => Date.now() }) {
  if (env.BXAGI_BACKGROUND_ENABLED !== 'true') return { enabled: false, skipped: 'disabled', processed: 0 };
  if (!env.DB?.prepare) throw Object.assign(new Error('后台调度存储未配置'), { status: 503, code: 'background_storage_unavailable' });
  const started = new Date(now()).toISOString(), leaseId = crypto.randomUUID();
  const leaseUntil = new Date(now() + LEASE_MS).toISOString();
  const result = await query(env.DB, `INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details)
    VALUES (?,?,?,?,'','',?,'running',?) ON CONFLICT(id) DO UPDATE SET status='running',updatedAt=excluded.updatedAt,
    details=json_set(jobs.details,'$.leaseId',?,'$.leaseUntil',?,'$.lastAttemptAt',?)
    WHERE jobs.userId=? AND jobs.type=? AND (json_extract(jobs.details,'$.leaseId') IS NULL OR json_extract(jobs.details,'$.leaseUntil') <= ?)`,
    ID, OWNER, started, started, TYPE, JSON.stringify({ leaseId, leaseUntil, lastAttemptAt: started }),
    leaseId, leaseUntil, started, OWNER, TYPE, started).run();
  if (!Number(result.meta?.changes ?? result.changes ?? 0)) return { enabled: true, skipped: 'busy', processed: 0 };
  try {
    const output = await work();
    const finished = new Date(now()).toISOString();
    const saved = await query(env.DB, `UPDATE jobs SET status='healthy',updatedAt=?,details=json_set(json_remove(details,'$.leaseId','$.leaseUntil'),'$.lastSuccessfulTickAt',?)
      WHERE id=? AND userId=? AND type=? AND json_extract(details,'$.leaseId')=?`, finished, finished, ID, OWNER, TYPE, leaseId).run();
    if (!Number(saved.meta?.changes ?? saved.changes ?? 0)) throw new Error('scheduler_lease_lost');
    return { enabled: true, ...output };
  } catch {
    await query(env.DB, `UPDATE jobs SET status='error',updatedAt=?,details=json_remove(details,'$.leaseId','$.leaseUntil')
      WHERE id=? AND userId=? AND type=? AND json_extract(details,'$.leaseId')=?`, new Date(now()).toISOString(), ID, OWNER, TYPE, leaseId).run();
    throw Object.assign(new Error('后台调度本轮未完整完成，已保留任务状态'), { status: 503, code: 'background_tick_incomplete' });
  }
}

export async function schedulerAuthorized(request, env) {
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 1024) return false;
  const hash = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  for (const secret of [env.BXAGI_SCHEDULER_SECRET, env.APP_WORKER_SECRET]) {
    if (typeof secret !== 'string' || !secret) continue;
    if (secret === env.BXAGI_SCHEDULER_SECRET && secret.length < 32) continue;
    const [a, b] = await Promise.all([hash(supplied), hash(`Bearer ${secret}`)]);
    let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    if (difference === 0) return true;
  }
  return false;
}
