import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error('Use Node.js 22.13 or newer.');
}

process.chdir(root);
process.env.BXAGI_STANDALONE = 'true';
process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= 'false';
process.env.WRANGLER_SEND_METRICS ??= 'false';
process.env.WRANGLER_WRITE_LOGS ??= 'false';
const args = process.argv.slice(2);
const hasPort = args.some(arg => arg === '--port' || arg === '-p' || arg.startsWith('--port='));
const cli = new URL('../node_modules/vinext/dist/cli.js', import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), 'dev', ...(!hasPort ? ['--port', '5173'] : []), ...args];
await import(cli.href);
