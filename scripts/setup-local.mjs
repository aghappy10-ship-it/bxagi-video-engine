import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try {
  writeFileSync(new URL('../.dev.vars', import.meta.url), [
    `APP_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    `APP_WORKER_SECRET=${randomBytes(32).toString('hex')}`,
    'BXAGI_REQUIRED=true',
    'BXAGI_BACKGROUND_ENABLED=false',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created ignored local development settings. Secret values are not printed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Keeping existing .dev.vars unchanged.');
}

const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'd1', 'migrations', 'apply', 'bxagi-advertising', '--local',
  '--config', 'wrangler.standalone.jsonc',
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: 'true', CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs', WRANGLER_REGISTRY_PATH: '.wrangler/registry' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
