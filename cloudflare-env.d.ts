declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    APP_ENCRYPTION_KEY?: string;
    APP_WORKER_SECRET?: string;
    APP_MAX_DAILY_BUDGET?: string;
    BXAGI_REQUIRED?: string;
    APP_BXAGI_TIMEOUT_MS?: string;
  }
}
