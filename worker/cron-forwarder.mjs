/** A deterministic cloud timer. No model, database, browser or user login. */
const TICK_PATH = '/api/v2/worker/background-tick';
const TIMEOUT_MS = 55_000;

class SchedulerError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.name = 'SchedulerError';
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

function configuration(env) {
  let site;
  try { site = new URL(env?.SITE_URL); } catch { throw new SchedulerError('scheduler_site_invalid'); }
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || site.pathname !== '/') {
    throw new SchedulerError('scheduler_site_invalid');
  }
  const secret = env?.BXAGI_SCHEDULER_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 1024 || /\s/.test(secret)) {
    throw new SchedulerError('scheduler_secret_invalid');
  }
  const siteToken = env?.SITES_SERVICE_TOKEN;
  if (siteToken !== undefined && (typeof siteToken !== 'string' || siteToken.length > 8192 || /\s/.test(siteToken))) {
    throw new SchedulerError('scheduler_site_token_invalid');
  }
  return { url: new URL(TICK_PATH, site.origin).href, secret, siteToken };
}

/** The server owns leases, tenant authorization, retries and persisted progress. */
export async function forwardBackgroundTick(env, { fetcher = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const { url, secret, siteToken } = configuration(env);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
    throw new SchedulerError('scheduler_timeout_invalid');
  }
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json',
            ...(siteToken ? { 'OAI-Sites-Authorization': `Bearer ${siteToken}` } : {}) },
          body: '{}',
          redirect: 'manual',
          signal: controller.signal,
        });
        // Never consume provider data or follow a Location carrying the bearer.
        await response.body?.cancel();
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          throw new SchedulerError('scheduler_redirect_refused', response.status);
        }
        if (!response.ok) throw new SchedulerError('scheduler_http_failed', response.status);
        return { httpStatus: response.status };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new SchedulerError('scheduler_request_timeout'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    // Fetch errors may contain URLs, headers or provider data. Never log them.
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('scheduler_request_failed');
  } finally {
    clearTimeout(timer);
  }
}

export async function runScheduledTick(env, options = {}) {
  const started = Date.now();
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  try {
    const result = await forwardBackgroundTick(env, options);
    log({ event: 'bxagi_background_tick', outcome: 'acknowledged', httpStatus: result.httpStatus, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    const code = error instanceof SchedulerError ? error.code : 'scheduler_request_failed';
    log({ event: 'bxagi_background_tick', outcome: 'failed', code,
      ...(error instanceof SchedulerError && Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
      durationMs: Date.now() - started });
    throw new Error(code);
  }
}

export default {
  async scheduled(_controller, env, _ctx) {
    await runScheduledTick(env);
  },
  fetch() {
    // HTTP requests cannot start a timer run, including on preview URLs.
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
