// Builds the mobile web bundle into apps/mobile/www.
// Usage: node scripts/build-web.mjs [--dev] [--watch]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(here, '..');
const extensionDir = resolve(mobileDir, '../extension');
const require = createRequire(resolve(extensionDir, 'package.json'));
const webpackCli = require.resolve('webpack-cli/bin/cli.js');

const args = process.argv.slice(2);
const dev = args.includes('--dev') || args.includes('--watch');
const env = ['--env', `config=${dev ? 'dev' : 'pro'}`];
if (args.includes('--watch')) env.push('--env', 'watch=true');

const result = spawnSync(
  process.execPath,
  [webpackCli, '--config', resolve(mobileDir, 'webpack.config.js'), ...env],
  { cwd: extensionDir, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
