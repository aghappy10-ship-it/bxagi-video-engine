import { handlePlatformRequest } from "../server/platform-api.mjs";

type BackgroundEnv = Cloudflare.Env & { BXAGI_BACKGROUND_ENABLED?: string };
type Dispatcher = (request: Request, env: BackgroundEnv) => Promise<Response | undefined>;

/** Both paths use existing service authentication and durable operation leases. */
export async function runScheduledTicks(
  env: BackgroundEnv,
  dispatch: Dispatcher = handlePlatformRequest,
) {
  if (env.BXAGI_BACKGROUND_ENABLED !== "true") return { enabled: false, completed: 0 };
  if (!env.APP_WORKER_SECRET) throw new Error("Background worker service secret is not configured");

  // Start budget monitoring and flow advancement independently. A slow remote
  // employee request must not postpone the budget monitor until it completes.
  const paths = ["/worker/background-tick"];
  const outcomes = await Promise.allSettled(paths.map(async (path) => {
    const response = await dispatch(new Request(`https://bxagi.internal/api/v2${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.APP_WORKER_SECRET}`, "Content-Type": "application/json" },
      body: "{}",
    }), env);
    if (!response) throw new Error("Background endpoint did not return a response");
    // No user data, tokens, employee messages or provider responses are logged.
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Background endpoint returned HTTP ${response.status}`);
  }));
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    // Rejection is visible to the scheduling platform; durable leases make the
    // following tick safe after an interrupted remote stage.
    throw new Error("One or more background worker endpoints did not complete");
  }
  return { enabled: true, completed: outcomes.length };
}

/** Independent entry: identity and sessions belong to the BXAGI application. */
export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const { default: handler } = await import("vinext/server/fetch-handler");
    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: BackgroundEnv, _ctx: ExecutionContext) {
    // Await completion so cron failures remain observable. This hook belongs
    // only to a separately deployed standalone Worker, not the current host.
    await runScheduledTicks(env);
  },
};
