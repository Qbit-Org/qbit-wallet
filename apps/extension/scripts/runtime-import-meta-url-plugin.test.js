/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const webpack = require('webpack');

const RuntimeImportMetaUrlPlugin = require('../build/plugins/RuntimeImportMetaUrlPlugin');
const createWebpackConfig = require('../webpack.config');

const extensionDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionDir, '../..');
const pqcLoaderPath = fs.realpathSync(require.resolve('@qbit-oss/pqc/wasm/pqc.mjs', { paths: [extensionDir] }));
const pqcWasmPath = fs.realpathSync(require.resolve('@qbit-oss/pqc/wasm/pqc.wasm', { paths: [extensionDir] }));
const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

// The configuration `build:chrome:mv3` compiles (it also sets the production
// NODE_ENV/BABEL_ENV that the Babel preset requires).
function releaseConfig() {
  return createWebpackConfig({ browser: 'chrome', manifest: 'mv3', channel: 'store', config: 'pro' });
}

function releasePlugin() {
  const plugins = releaseConfig().plugins.filter((plugin) => plugin instanceof RuntimeImportMetaUrlPlugin);
  assert.equal(plugins.length, 1, 'the extension build must register RuntimeImportMetaUrlPlugin once');
  return plugins[0];
}

// Bundles `entry` the way background.js is built: the extension's own module
// rules (Babel, the pqc.wasm asset rule), resolver and provided globals, for a
// worker target whose base URI is `self.location`.
function bundle(context, entry, plugins) {
  const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-import-meta-url-'));
  context.after(() => fs.rmSync(outputPath, { force: true, recursive: true }));
  const config = releaseConfig();
  const compiler = webpack({
    mode: 'production',
    context: extensionDir,
    target: 'webworker',
    entry: { background: entry },
    output: {
      path: outputPath,
      filename: '[name].js',
      publicPath: '/',
      chunkFilename: 'chunk.[name].js',
      library: { name: 'bundled', type: 'self' }
    },
    module: config.module,
    resolve: config.resolve,
    experiments: config.experiments,
    optimization: { minimize: false },
    plugins: [
      ...config.plugins.filter(
        (plugin) => plugin instanceof webpack.ProvidePlugin || plugin instanceof webpack.DefinePlugin
      ),
      ...plugins
    ],
    infrastructureLogging: { level: 'error' },
    stats: 'none'
  });
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close(() => {
        if (error) {
          reject(error);
        } else if (stats.hasErrors()) {
          reject(new Error(stats.toString({ all: false, errors: true })));
        } else {
          resolve({ outputPath, bundle: fs.readFileSync(path.join(outputPath, 'background.js'), 'utf8') });
        }
      });
    });
  });
}

test('the extension build rewrites import.meta.url only in the PQC Emscripten loader', () => {
  const plugin = releasePlugin();

  assert.equal(plugin.test.test(pqcLoaderPath), true);
  assert.equal(plugin.test.test(pqcWasmPath), false);
  assert.equal(plugin.test.test(path.join(path.dirname(pqcLoaderPath), '../lib/index.mjs')), false);
  assert.throws(() => new RuntimeImportMetaUrlPlugin({ test: 'pqc.mjs' }), /requires a RegExp/);
});

test('without the plugin webpack inlines the builder path into the PQC loader (#338 control)', async (context) => {
  const { bundle: output } = await bundle(context, pqcLoaderPath, []);

  assert.ok(
    output.includes(pathToFileURL(pqcLoaderPath).href),
    'webpack no longer inlines import.meta.url as a file URL'
  );
});

test('the bundled PQC loader carries no builder path and still loads the WASM asset in a worker', async (context) => {
  const { outputPath, bundle: output } = await bundle(context, pqcLoaderPath, [releasePlugin()]);

  assert.doesNotMatch(output, /file:\/\/\//);
  assert.equal(output.includes(repoRoot), false, 'bundle embeds the checkout path');
  assert.equal(output.includes(os.homedir()), false, 'bundle embeds the home directory');
  assert.deepEqual(fs.readFileSync(path.join(outputPath, 'wasm/pqc.wasm')), fs.readFileSync(pqcWasmPath));

  const wasmUrl = `${extensionOrigin}/wasm/pqc.wasm`;
  const fetched = [];
  const sandbox = vm.createContext({
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    WorkerGlobalScope: function WorkerGlobalScope() {},
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    fetch: async (url) => {
      fetched.push(String(url));
      if (String(url) !== wasmUrl) {
        return new Response(null, { status: 404 });
      }
      return new Response(fs.readFileSync(path.join(outputPath, 'wasm/pqc.wasm')), {
        headers: { 'content-type': 'application/wasm' }
      });
    },
    importScripts: () => {
      throw new Error('the worker must not load extra chunks');
    },
    location: new URL(`${extensionOrigin}/background.js`),
    setTimeout
  });
  sandbox.self = sandbox;
  vm.runInContext(output, sandbox, { filename: 'background.js' });

  const prefixes = [];
  // The same locateFile contract as apps/extension/src/background/init/restore.ts.
  const pqcModule = await sandbox.bundled.default({
    locateFile: (wasmPath, prefix) => {
      prefixes.push(prefix);
      return `${extensionOrigin}/wasm/${wasmPath}`;
    }
  });

  // Emscripten's scriptDirectory is the bundle's directory, not the builder's disk.
  assert.deepEqual(prefixes, [`${extensionOrigin}/`]);
  assert.deepEqual(fetched, [wasmUrl]);
  assert.equal(typeof pqcModule._qbit_pqc_public_key_size, 'function');
  assert.ok(pqcModule._qbit_pqc_public_key_size() > 0);
});

test('the parser does not fold conditions on import.meta.url to the builder path', async (context) => {
  const fixtureDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-import-meta-fixture-')));
  context.after(() => fs.rmSync(fixtureDirectory, { force: true, recursive: true }));
  const fixturePath = path.join(fixtureDirectory, 'loader.mjs');
  fs.writeFileSync(
    fixturePath,
    // Webpack folds `indexOf` on a compile-time string.
    'export const where = import.meta.url.indexOf("file:") === 0 ? "node" : "web";\nexport const url = import.meta.url;\n'
  );
  const { bundle: output } = await bundle(context, fixturePath, [
    new RuntimeImportMetaUrlPlugin({ test: /loader\.mjs$/ })
  ]);

  assert.doesNotMatch(output, /file:\/\/\//);
  assert.equal(output.includes(fixtureDirectory), false, 'bundle embeds the fixture path');
  const sandbox = vm.createContext({ location: new URL(`${extensionOrigin}/background.js`) });
  sandbox.self = sandbox;
  vm.runInContext(output, sandbox, { filename: 'background.js' });
  assert.equal(sandbox.bundled.where, 'web');
  assert.equal(sandbox.bundled.url, `${extensionOrigin}/background.js`);
});
