import { access, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist-standalone');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 13) throw new Error('Standalone build requires Node.js 22.13 or newer.');

process.chdir(root);
process.env.BXAGI_STANDALONE = 'true';
process.env.NODE_ENV = 'production';
process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= 'false';
process.env.WRANGLER_SEND_METRICS ??= 'false';
process.env.WRANGLER_WRITE_LOGS ??= 'false';
process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
process.env.WRANGLER_REGISTRY_PATH ??= '.wrangler/dev-registry';
process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

await access(resolve(root, 'node_modules/vite/package.json')).catch(() => { throw new Error('Run npm ci before building the standalone application.'); });
await rm(output, { recursive: true, force: true });

// Vite's builder loads the independent config branch directly. It does not run
// any Sites environment wrappers, authentication mocks or publishing helpers.
const { createBuilder } = await import('vite');
const builder = await createBuilder({ root, configFile: resolve(root, 'vite.config.ts') });
await builder.buildApp();

const configPath = resolve(output, 'server/wrangler.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!config.main || !config.d1_databases?.some(binding => binding.binding === 'DB') || !config.r2_buckets?.some(binding => binding.binding === 'BUCKET')) {
  throw new Error('Standalone output is missing its application entry, D1 DB or R2 BUCKET binding.');
}
if (config.services?.some(binding => binding.binding === 'CONNECTORS')) throw new Error('Standalone output unexpectedly depends on a hosting connector service.');
await access(resolve(output, 'server', config.main));
await access(resolve(output, 'client'));
console.log('Independent BXAGI build created: dist-standalone/server/wrangler.json');
console.log('This is a build only. Configure your own Cloudflare resources, apply migrations and deploy separately.');
