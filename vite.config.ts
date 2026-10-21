import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig(async ({ command }) => {
  // Use Miniflare's local Request.cf placeholder unless fetching is requested.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  if (process.env.BXAGI_STANDALONE === "true") {
    return {
      // These directories keep the independently deployable app separate from
      // the current hosted build. No Sites metadata or plugins are loaded here.
      build: { outDir: "dist-standalone" },
      environments: { client: { build: { outDir: "dist-standalone/client" } } },
      plugins: [
        vinext({
          rscOutDir: "dist-standalone/server",
          ssrOutDir: "dist-standalone/server/ssr",
          clientOutDir: "dist-standalone/client",
        }),
        cloudflare({
          viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
          inspectorPort: false,
          configPath: "./wrangler.standalone.jsonc",
        }),
      ],
    };
  }

  // The existing hosting path is optional. Reading its manifest is deliberately
  // deferred, so a clean standalone checkout needs no project identity file.
  const { readFile } = await import("node:fs/promises");
  const hostingConfig = JSON.parse(await readFile(new URL("./.openai/hosting.json", import.meta.url), "utf8"));
  const [{ readExecutionProfile }, { sites }, { connectorPreview }] = await Promise.all([
    import("./scripts/execution-profile.mjs"),
    import("./build/sites-vite-plugin"),
    import("./build/connector-preview-plugin.mjs"),
  ]);
  const { d1, r2 } = hostingConfig;
  const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
  const managedLinux = readExecutionProfile() === "managed-linux";
  const localBindingConfig = {
    main: "./build/sites-worker.ts",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: d1 ? [{ binding: d1, database_name: "site-creator-d1", database_id: "00000000-0000-4000-8000-000000000000" }] : [],
    r2_buckets: r2 ? [{ binding: r2, bucket_name: "site-creator-r2" }] : [],
  };

  return {
    server: {
      ...(managedLinux
        ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] }
        : {}),
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites({ mockAuth: !managedLinux }),
      connectorPreview(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: {
          ...localBindingConfig,
          ...(command === "serve"
            ? {
                services: [
                  {
                    binding: "CONNECTORS",
                    service: "sites-connector-preview",
                    entrypoint: "ConnectorPreview",
                  },
                ],
              }
            : {}),
        },
        ...(command === "serve"
          ? {
              auxiliaryWorkers: [
                {
                  config: {
                    name: "sites-connector-preview",
                    main: "./build/connector-preview-worker.mjs",
                    compatibility_date: "2026-05-15",
                  },
                },
              ],
            }
          : {}),
      }),
    ],
  };
});
