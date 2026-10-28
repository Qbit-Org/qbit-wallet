const fs = require('fs');
const path = require('path');
const webpack = require('webpack');

const extensionDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionDir, '../..');
const pqcPackageRoot = findPqcPackageRoot();
const pqcIndexPath = path.resolve(pqcPackageRoot, 'lib/index.mjs');
const pqcWasmLoaderPath = path.resolve(pqcPackageRoot, 'wasm/pqc.mjs');
const pqcWasmPath = path.resolve(pqcPackageRoot, 'wasm/pqc.wasm');
const mv3ManifestPath = path.join(extensionDir, 'build/_raw/manifest/_base_v3.json');
const smokeRoot = path.join(repoRoot, '.context/extension-pqc-import');
const entryPath = path.join(smokeRoot, 'entry.mjs');
const outDir = path.join(smokeRoot, 'dist');

process.env.BABEL_ENV = process.env.BABEL_ENV || 'production';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findPqcPackageRoot() {
  try {
    return path.dirname(require.resolve('@qbit-oss/pqc/package.json', { paths: [extensionDir] }));
  } catch {
    fail('could not locate the @qbit-oss/pqc package root; run pnpm install');
  }
}

function writeEntry() {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  fs.mkdirSync(smokeRoot, { recursive: true });
  fs.writeFileSync(
    entryPath,
    `import { constants, init } from '@qbit-oss/pqc';
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs';

if (typeof init !== 'function') {
  throw new Error('@qbit-oss/pqc init export missing');
}
if (constants.PK_SIZE !== 32 || constants.SK_SIZE !== 64 || constants.SIG_SIZE !== 3680) {
  throw new Error('@qbit-oss/pqc constants mismatch');
}

globalThis.__QBIT_PQC_EXTENSION_IMPORT_SMOKE__ = (async () => {
  const locateFile = wasmPath => {
    const localPath = \`wasm/\${wasmPath}\`;
    if (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.getURL === 'function'
    ) {
      return chrome.runtime.getURL(localPath);
    }
    return localPath;
  };
  const pqc = await init({
    createModule: createPqcModule,
    locateFile,
  });

  return {
    ok: true,
    package: '@qbit-oss/pqc',
    wasmLoader: '@qbit-oss/pqc/wasm/pqc.mjs',
    wasmUrl: locateFile('pqc.wasm'),
    wasmHeapBytes: pqc.wasmHeapBytes(),
    signatureBytes: constants.SIG_SIZE,
  };
})();
`
  );
}

function buildWebpackConfig() {
  const makeCommonConfig = require('../build/webpack.common.config.js');
  const extensionPackage = readJson(path.join(extensionDir, 'package.json'));
  const baseConfig = makeCommonConfig({
    browser: 'chrome',
    manifest: 'mv3',
    config: 'pro',
    channel: 'store',
    version: extensionPackage.version,
  });

  return {
    mode: 'production',
    target: 'webworker',
    context: extensionDir,
    entry: {
      'pqc-import-smoke': entryPath,
    },
    output: {
      path: outDir,
      filename: '[name].js',
      chunkFilename: 'chunk.[name].js',
      clean: true,
    },
    resolve: {
      ...baseConfig.resolve,
      modules: [path.join(extensionDir, 'node_modules'), ...(baseConfig.resolve.modules || [])],
    },
    module: baseConfig.module,
    experiments: {
      ...baseConfig.experiments,
      topLevelAwait: true,
    },
    optimization: {
      minimize: false,
    },
    stats: 'errors-warnings',
  };
}

function runWebpack(config) {
  return new Promise((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => {
      compiler.close(closeError => {
        if (error) {
          reject(error);
          return;
        }
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(stats);
      });
    });
  });
}

function assertPackageDeclared() {
  const extensionPackage = readJson(path.join(extensionDir, 'package.json'));
  const pin = readJson(path.join(repoRoot, 'scripts/security/sdk-package-pins.json')).packages.find(
    (entry) => entry.package === '@qbit-oss/pqc'
  );
  if (!pin) {
    fail('scripts/security/sdk-package-pins.json does not pin @qbit-oss/pqc');
  }
  if (extensionPackage.dependencies?.['@qbit-oss/pqc'] !== pin.version) {
    fail(`apps/extension must declare "@qbit-oss/pqc": "${pin.version}" for the import smoke`);
  }
  if (readJson(path.join(pqcPackageRoot, 'package.json')).version !== pin.version) {
    fail(`installed @qbit-oss/pqc is not ${pin.version}; run pnpm install`);
  }
  for (const artifactPath of [pqcIndexPath, pqcWasmLoaderPath, pqcWasmPath]) {
    if (!fs.existsSync(artifactPath)) {
      fail(`missing ${artifactPath}; run pnpm install`);
    }
  }
}

function assertMv3Csp() {
  const manifest = readJson(mv3ManifestPath);
  const csp = manifest.content_security_policy?.extension_pages;
  if (typeof csp !== 'string') {
    fail('apps/extension MV3 manifest must define extension_pages CSP for PQC WASM');
  }
  const directives = csp.split(';').map(directive => directive.trim());
  const scriptSrc = directives.find(directive => directive.startsWith('script-src '));
  if (!csp.includes("script-src 'self'")) {
    fail('apps/extension MV3 CSP must keep script-src restricted to self');
  }
  if (!csp.includes("'wasm-unsafe-eval'")) {
    fail("apps/extension MV3 CSP must include 'wasm-unsafe-eval' for local WASM");
  }
  if (csp.includes("'unsafe-eval'")) {
    fail("apps/extension MV3 CSP must not add plain 'unsafe-eval' for PQC");
  }
  if (/https?:/.test(scriptSrc || '')) {
    fail('apps/extension MV3 CSP must not add remote script origins for PQC');
  }

  return csp;
}

function assertStats(stats) {
  const info = stats.toJson({
    all: false,
    assets: true,
    errors: true,
    warnings: true,
    modules: true,
  });

  if (stats.hasErrors()) {
    fail(stats.toString({ colors: false, all: false, errors: true }));
  }

  const outputPath = path.join(outDir, 'pqc-import-smoke.js');
  if (!fs.existsSync(outputPath)) {
    fail(`webpack build completed but output was not found: ${outputPath}`);
  }
  const outputText = fs.readFileSync(outputPath, 'utf8');
  if (!outputText.includes('wasm/pqc.wasm')) {
    fail('webpack output does not reference the packaged wasm/pqc.wasm path');
  }
  if (!outputText.includes('chrome.runtime.getURL')) {
    fail('webpack output does not use chrome.runtime.getURL for the extension PQC locateFile path');
  }
  const wasmOutputPath = path.join(outDir, 'wasm/pqc.wasm');
  if (!fs.existsSync(wasmOutputPath)) {
    fail(`webpack build completed but local pqc.wasm was not packaged: ${wasmOutputPath}`);
  }
  if (!fs.readFileSync(wasmOutputPath).equals(fs.readFileSync(pqcWasmPath))) {
    fail('packaged wasm/pqc.wasm does not match @qbit-oss/pqc wasm/pqc.wasm');
  }

  const fileDependencies = Array.from(stats.compilation.fileDependencies ?? [], filePath =>
    path.resolve(filePath)
  );
  if (!fileDependencies.includes(pqcIndexPath)) {
    fail('webpack build completed but did not resolve @qbit-oss/pqc lib/index.mjs');
  }
  if (!fileDependencies.includes(pqcWasmLoaderPath)) {
    fail('webpack build completed but did not resolve @qbit-oss/pqc wasm/pqc.mjs');
  }

  return {
    outputPath,
    wasmOutputPath,
    assets: info.assets?.map(asset => ({ name: asset.name, size: asset.size })) ?? [],
    warnings: info.warnings?.map(warning => warning.message ?? String(warning)) ?? [],
  };
}

async function main() {
  assertPackageDeclared();
  const mv3Csp = assertMv3Csp();
  writeEntry();
  const stats = await runWebpack(buildWebpackConfig());
  const result = assertStats(stats);
  console.log(
    JSON.stringify(
      {
        ok: true,
        package: '@qbit-oss/pqc',
        outputPath: result.outputPath,
        wasmOutputPath: result.wasmOutputPath,
        mv3Csp,
        assets: result.assets,
        warnings: result.warnings,
      },
      null,
      2
    )
  );
}

main().catch(error => {
  fail(error?.stack ?? String(error));
});
