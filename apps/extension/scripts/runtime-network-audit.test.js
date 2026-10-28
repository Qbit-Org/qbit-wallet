/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '../../..');

const ChainType = Object.freeze({
  QBIT_MAINNET: 'QBIT_MAINNET',
  QBIT_REGTEST: 'QBIT_REGTEST',
  QBIT_TESTNET4: 'QBIT_TESTNET4'
});

const EXPECTED_NETWORKS = Object.freeze({
  [ChainType.QBIT_MAINNET]: {
    api: 'https://mempool.qbit.org/api',
    explorer: 'https://mempool.qbit.org',
    surface: 'mempool-qbit'
  },
  [ChainType.QBIT_TESTNET4]: {
    api: 'https://mempool-testnet.qbit.org/api',
    explorer: 'https://mempool-testnet.qbit.org',
    surface: 'mempool-qbit'
  },
  [ChainType.QBIT_REGTEST]: {
    api: 'http://127.0.0.1:3002',
    explorer: null,
    surface: 'esplora'
  }
});

function loadTypeScriptModule(relativePath, dependencies = {}) {
  const file = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    },
    fileName: file
  }).outputText;
  const loadedModule = { exports: {} };

  const requireDependency = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, specifier)) {
      return dependencies[specifier];
    }
    throw new Error(`Unexpected dependency ${specifier} while loading ${relativePath}`);
  };

  const execute = new Function('exports', 'require', 'module', '__filename', '__dirname', javascript);
  execute(loadedModule.exports, requireDependency, loadedModule, file, path.dirname(file));
  return loadedModule.exports;
}

function loadRuntimeModules() {
  const platform = loadTypeScriptModule('packages/wallet-shared/src/constants/platform.ts');
  const common = loadTypeScriptModule('packages/wallet-shared/src/constants/common.ts', {
    '@qbit/wallet-types': {
      AddressType: {
        P2PKH: 0,
        P2WPKH: 1,
        P2TR: 2,
        P2SH_P2WPKH: 3,
        BIP44_P2WPKH: 4,
        BIP44_P2TR: 5,
        P2WSH: 6,
        P2SH: 7,
        UNKNOWN: 8,
        P2MR: 9
      },
      ChainType,
      NetworkType: { MAINNET: 0, TESTNET: 1, REGTEST: 2 }
    },
    '../types/i18n': {},
    './platform': platform
  });
  const explorer = loadTypeScriptModule('packages/wallet-shared/src/utils/explorer.ts');
  // The ESM build of @qbit-oss/api that webpack bundles into the extension.
  const qbitApiRoot = path.dirname(
    require.resolve('@qbit-oss/api/package.json', { paths: [path.join(repoRoot, 'apps/extension')] })
  );
  const qbitApi = loadTypeScriptModule(path.relative(repoRoot, path.join(qbitApiRoot, 'lib/index.mjs')), {
    // Hashing only, for txid checks; it opens no connections.
    '@noble/hashes/sha256': require(require.resolve('@noble/hashes/sha256', { paths: [qbitApiRoot] }))
  });

  return { common, explorer, qbitApi };
}

function isWithinBase(candidate, configuredBase) {
  const url = new URL(candidate);
  const base = new URL(configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`);
  return url.origin === base.origin && url.pathname.startsWith(base.pathname);
}

function qbitResponse(url, init) {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/fees/recommended')) {
    return Response.json({ fastestFee: 4, halfHourFee: 3, hourFee: 2, economyFee: 1, minimumFee: 1 });
  }
  if (pathname.endsWith('/fee-estimates')) {
    return Response.json({ 1: 4, 2: 3, 3: 2 });
  }
  if (pathname.endsWith('/utxo')) {
    return Response.json([]);
  }
  if (pathname.endsWith('/status')) {
    return Response.json({ confirmed: false });
  }
  if (init?.method === 'POST' && pathname.endsWith('/tx')) {
    return new Response('0'.repeat(64), { status: 200 });
  }
  return Response.json({
    address: 'qb1qaudit',
    chain_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
    mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 }
  });
}

test('normal wallet network matrix stays within configured Qbit API and explorer endpoints', async (t) => {
  const { common, explorer, qbitApi } = loadRuntimeModules();
  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const configuredNetworks = Object.fromEntries(
    Object.keys(EXPECTED_NETWORKS).map((chainType) => {
      const chain = common.CHAINS_MAP[chainType];
      return [
        chainType,
        {
          api: chain.endpoints[0],
          explorer: explorer.getExplorerBaseUrl(chain) ?? null,
          surface: chain.qbitApiSurface ?? 'esplora'
        }
      ];
    })
  );
  assert.deepEqual(configuredNetworks, EXPECTED_NETWORKS, 'review changes to the production endpoint allowlist');

  globalThis.fetch = async (url) => {
    assert.fail(`request escaped the injected fetchFn to global fetch: ${String(url)}`);
  };

  for (const chainType of Object.keys(EXPECTED_NETWORKS)) {
    const chain = common.CHAINS_MAP[chainType];
    const Client = chain.qbitApiSurface === 'mempool-qbit' ? qbitApi.MempoolQbitClient : qbitApi.EsploraClient;
    const direct = new Client({
      baseUrl: chain.endpoints[0],
      fetchFn: async (url, init) => {
        requests.push({ chainType, stack: 'direct-esplora', url: String(url), init });
        return qbitResponse(String(url), init);
      },
      retries: 0
    });

    await direct.getAddressStats('qb1qaudit');
    await direct.getAddressUtxos('qb1qaudit');
    await direct.getTxStatus('0'.repeat(64));
    await direct.getFeeEstimates();
    await direct.broadcastTx('00');

    for (const resource of ['address', 'block', 'tx']) {
      const explorerUrl = explorer.getExplorerUrl(chain, resource, 'audit-id');
      if (EXPECTED_NETWORKS[chainType].explorer === null) {
        assert.equal(explorerUrl, undefined);
      } else {
        assert.ok(isWithinBase(explorerUrl, EXPECTED_NETWORKS[chainType].explorer));
      }
    }
  }

  assert.equal(requests.length, Object.keys(EXPECTED_NETWORKS).length * 5);
  for (const request of requests) {
    const expected = EXPECTED_NETWORKS[request.chainType];
    assert.ok(
      isWithinBase(request.url, expected.api),
      `${request.stack} escaped ${expected.api}: ${request.url}`
    );
  }
});
