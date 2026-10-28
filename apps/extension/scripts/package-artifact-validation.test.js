/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  E2E_REGTEST_HOST_PERMISSION,
  E2E_REGTEST_ORIGIN,
  EXPECTED_MV3_CSP,
  EXPECTED_MV3_HOST_PERMISSIONS,
  EXPECTED_MV3_OPTIONAL_HOST_PERMISSIONS,
  EXPECTED_MV3_PERMISSIONS,
  REGTEST_HOST_PERMISSION,
  REGTEST_ORIGIN,
  assertArchiveManifestEntryList,
  assertBundledPqcWasmHash,
  assertNoForbiddenHosts,
  assertRequiredBundleEntries,
  assertSecureArchiveEntries,
  assertSecureMv3Manifest,
  parseArchiveEntries
} = require('./package-artifact-validation');
const { mergeExtensionManifest } = require('./manifest-build-flavors');

const extensionDir = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(extensionDir, relativePath), 'utf8'));
}

function currentChromeMv3Manifest(channel = 'store') {
  return mergeExtensionManifest({
    baseManifest: readJson('build/_raw/manifest/_base_v3.json'),
    browserManifest: readJson('build/_raw/manifest/chrome.json'),
    version: '0.1.0',
    channel
  });
}

function secureManifestFixture() {
  return {
    manifest_version: 3,
    permissions: [...EXPECTED_MV3_PERMISSIONS],
    host_permissions: [...EXPECTED_MV3_HOST_PERMISSIONS],
    optional_host_permissions: [...EXPECTED_MV3_OPTIONAL_HOST_PERMISSIONS],
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['content-script.js'],
        run_at: 'document_start'
      }
    ],
    web_accessible_resources: [
      {
        resources: ['pageProvider.js'],
        matches: ['<all_urls>']
      }
    ],
    content_security_policy: {
      extension_pages: EXPECTED_MV3_CSP
    }
  };
}

test('accepts an artifact with every required root bundle', () => {
  const listing = [
    'manifest.json',
    'background.js',
    'content-script.js',
    'pageProvider.js',
    'ui.js',
    'images/icon-128.png'
  ].join('\n');

  assert.doesNotThrow(() => assertRequiredBundleEntries(listing));
});

test('reports every missing required bundle', () => {
  assert.throws(
    () => assertRequiredBundleEntries('manifest.json\nbackground.js\n'),
    /artifact is missing required bundle entries: content-script\.js, pageProvider\.js, ui\.js/
  );
});

test('does not accept nested, suffixed, or basename-only bundle matches', () => {
  const listing = ['scripts/background.js', 'nested/content-script.js', 'pageProvider.js.map', 'assets/ui.js'].join(
    '\n'
  );

  assert.throws(
    () => assertRequiredBundleEntries(listing),
    /background\.js, content-script\.js, pageProvider\.js, ui\.js/
  );
});

test('normalizes Buffer, CRLF, and trailing blank command output', () => {
  const output = Buffer.from('background.js\r\ncontent-script.js\r\npageProvider.js\r\nui.js\r\n\r\n');

  assert.deepEqual(parseArchiveEntries(output), ['background.js', 'content-script.js', 'pageProvider.js', 'ui.js']);
  assert.doesNotThrow(() => assertRequiredBundleEntries(output));
});

test('store loopback constants agree with the shared wallet constants', () => {
  const sharedSource = fs.readFileSync(
    path.join(extensionDir, '../../packages/wallet-shared/src/constants/qbit-regtest.ts'),
    'utf8'
  );
  assert.match(sharedSource, new RegExp(`QBIT_REGTEST_ORIGIN = '${REGTEST_ORIGIN.replace(/[./]/g, '\\$&')}'`));
  assert.equal(REGTEST_HOST_PERMISSION, `${REGTEST_ORIGIN}/*`);
  assert.equal(E2E_REGTEST_ORIGIN, REGTEST_ORIGIN);
  assert.equal(E2E_REGTEST_HOST_PERMISSION, REGTEST_HOST_PERMISSION);
});

test('checked-in Chrome MV3 store manifest matches the reviewed release boundary', () => {
  const manifest = currentChromeMv3Manifest();

  assert.deepEqual(manifest.host_permissions, EXPECTED_MV3_HOST_PERMISSIONS);
  assert.deepEqual(manifest.optional_host_permissions, [REGTEST_HOST_PERMISSION]);
  assert.equal(manifest.content_security_policy.extension_pages, EXPECTED_MV3_CSP);
  const connectSrc = EXPECTED_MV3_CSP.split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src'))
    .split(/\s+/)
    .slice(1);
  assert.deepEqual(connectSrc, ["'self'", 'https://mempool.qbit.org', 'https://mempool-testnet.qbit.org', REGTEST_ORIGIN]);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'optional_permissions'), false);
  assert.doesNotThrow(() => assertSecureMv3Manifest(manifest));
});

test('e2e Chrome MV3 manifest promotes loopback to a required permission without a duplicate optional entry', () => {
  const storeManifest = currentChromeMv3Manifest('store');
  const e2eManifest = currentChromeMv3Manifest('e2e');

  assert.deepEqual(storeManifest.host_permissions, EXPECTED_MV3_HOST_PERMISSIONS);
  assert.deepEqual(storeManifest.optional_host_permissions, [REGTEST_HOST_PERMISSION]);
  assert.equal(storeManifest.content_security_policy.extension_pages, EXPECTED_MV3_CSP);

  assert.deepEqual(e2eManifest.host_permissions, [...EXPECTED_MV3_HOST_PERMISSIONS, REGTEST_HOST_PERMISSION]);
  assert.equal(Object.prototype.hasOwnProperty.call(e2eManifest, 'optional_host_permissions'), false);
  assert.equal(
    e2eManifest.content_security_policy.extension_pages
      .split(/\s+/)
      .filter((source) => source === REGTEST_ORIGIN).length,
    1
  );
  assert.equal(e2eManifest.content_security_policy.extension_pages, EXPECTED_MV3_CSP);
  assert.throws(() => assertSecureMv3Manifest(e2eManifest), /host_permissions/);
});

test('the store archive manifest must agree with the generated store manifest', () => {
  const generated = currentChromeMv3Manifest('store');
  const packaged = JSON.parse(JSON.stringify(generated));
  assert.doesNotThrow(() => assertSecureMv3Manifest(packaged));

  packaged.optional_host_permissions = [];
  assert.throws(() => assertSecureMv3Manifest(packaged), /optional_host_permissions/);
});

test('rejects broad, unscoped, hostname, redirect-target, and all-URL hosts in every permission list', () => {
  const forbidden = [
    'http://*/*',
    '*://*/*',
    'http://127.0.0.1/*',
    'http://127.0.0.1:*/*',
    'http://127.*/*',
    'http://localhost/*',
    'http://localhost:3002/*',
    'http://[::1]:3002/*',
    'http://127.0.0.1:3003/*',
    '<all_urls>',
    'http:'
  ];
  for (const entry of forbidden) {
    assert.throws(() => assertNoForbiddenHosts('host_permissions', [entry]), /forbidden/, entry);
  }
  assert.doesNotThrow(() => assertNoForbiddenHosts('host_permissions', [REGTEST_HOST_PERMISSION]));
  assert.doesNotThrow(() => assertNoForbiddenHosts('CSP connect-src', ["'self'", REGTEST_ORIGIN]));
});

test('accepts only the reviewed MV3 permission, host, frame, resource, and CSP policy', () => {
  assert.doesNotThrow(() => assertSecureMv3Manifest(secureManifestFixture()));

  const mutations = [
    {
      label: 'extra activeTab permission',
      mutate: (manifest) => manifest.permissions.push('activeTab'),
      message: /permissions/
    },
    {
      label: 'all-host network access',
      mutate: (manifest) => manifest.host_permissions.splice(0, Infinity, '<all_urls>'),
      message: /host_permissions/
    },
    {
      label: 'loopback promoted to a required permission',
      mutate: (manifest) => manifest.host_permissions.push(REGTEST_HOST_PERMISSION),
      message: /host_permissions/
    },
    {
      label: 'loopback duplicated as required and optional',
      mutate: (manifest) => {
        manifest.host_permissions.push(REGTEST_HOST_PERMISSION);
      },
      message: /host_permissions/
    },
    {
      label: 'missing optional loopback permission',
      mutate: (manifest) => {
        delete manifest.optional_host_permissions;
      },
      message: /optional_host_permissions/
    },
    {
      label: 'empty optional loopback permission',
      mutate: (manifest) => manifest.optional_host_permissions.splice(0, Infinity),
      message: /optional_host_permissions/
    },
    {
      label: 'extra optional origin',
      mutate: (manifest) => manifest.optional_host_permissions.push('https://example.com/*'),
      message: /optional_host_permissions/
    },
    {
      label: 'optional all-URL access',
      mutate: (manifest) => manifest.optional_host_permissions.splice(0, Infinity, '<all_urls>'),
      message: /forbidden all-URL host access/
    },
    {
      label: 'optional wildcard HTTP host',
      mutate: (manifest) => manifest.optional_host_permissions.splice(0, Infinity, 'http://*/*'),
      message: /forbidden wildcard scheme or host/
    },
    {
      label: 'optional all-port loopback',
      mutate: (manifest) => manifest.optional_host_permissions.splice(0, Infinity, 'http://127.0.0.1/*'),
      message: /forbidden unscoped loopback port/
    },
    {
      label: 'optional localhost hostname',
      mutate: (manifest) => manifest.optional_host_permissions.splice(0, Infinity, 'http://localhost:3002/*'),
      message: /forbidden localhost hostname/
    },
    {
      label: 'optional redirect-target port',
      mutate: (manifest) => manifest.optional_host_permissions.splice(0, Infinity, 'http://127.0.0.1:3003/*'),
      message: /forbidden non-reviewed loopback port/
    },
    {
      label: 'MV2-style optional_permissions block',
      mutate: (manifest) => {
        manifest.optional_permissions = [REGTEST_HOST_PERMISSION];
      },
      message: /optional_permissions is forbidden/
    },
    {
      label: 'child-frame injection',
      mutate: (manifest) => {
        manifest.content_scripts[0].all_frames = true;
      },
      message: /child frames/
    },
    {
      label: 'extension page exposed to websites',
      mutate: (manifest) => manifest.web_accessible_resources[0].resources.push('index.html'),
      message: /web_accessible_resources/
    },
    {
      label: 'external messaging surface',
      mutate: (manifest) => {
        manifest.externally_connectable = { matches: ['https://qbit.org/*'] };
      },
      message: /externally_connectable/
    },
    {
      label: 'scheme-wide connect source',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages =
          "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src https:";
      },
      message: /CSP/
    },
    {
      label: 'duplicate loopback connect source',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages += ` ${REGTEST_ORIGIN}`;
      },
      message: /CSP/
    },
    {
      label: 'missing loopback connect source',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
          ` ${REGTEST_ORIGIN}`,
          ''
        );
      },
      message: /exact reviewed loopback origin/
    },
    {
      label: 'localhost connect source',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
          REGTEST_ORIGIN,
          'http://localhost:3002'
        );
      },
      message: /forbidden localhost hostname/
    },
    {
      label: 'all-port loopback connect source',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
          REGTEST_ORIGIN,
          'http://127.0.0.1:*'
        );
      },
      message: /forbidden unscoped loopback port/
    },
    {
      label: 'redirect-target connect source',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages += ' http://127.0.0.1:3003';
      },
      message: /forbidden non-reviewed loopback port/
    },
    {
      label: 'wildcard HTTP connect source',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages += ' http://*';
      },
      message: /forbidden wildcard scheme or host/
    }
  ];

  for (const { label, mutate, message } of mutations) {
    const manifest = secureManifestFixture();
    mutate(manifest);
    assert.throws(() => assertSecureMv3Manifest(manifest), message, label);
  }
});

test('accepts a sorted release package with required runtime and PQC entries', () => {
  const listing = [
    'background.js',
    'content-script.js',
    'manifest.json',
    'pageProvider.js',
    'ui.js',
    'wasm/pqc.wasm'
  ];
  assert.deepEqual(assertSecureArchiveEntries(listing.join('\n')), listing);
  assert.doesNotThrow(() =>
    assertArchiveManifestEntryList(listing, {
      schemaVersion: 1,
      entries: listing.map((entry) => ({ path: entry, sha256: '00'.repeat(32), size: 1 }))
    })
  );
});

test('rejects unsafe, duplicate, forbidden, unsorted, missing, or unmanifested package entries', () => {
  const required = [
    'background.js',
    'content-script.js',
    'manifest.json',
    'pageProvider.js',
    'ui.js',
    'wasm/pqc.wasm'
  ];
  const invalidListings = [
    [['../escape.js', ...required], /unsafe archive path/],
    [[...required, 'background.js'].sort(), /duplicate archive path/],
    [[...required, 'ui.js.map'].sort(), /forbidden source map/],
    [[...required, '.env.production'].sort(), /forbidden environment file/],
    [[...required, 'release-signing.pem'].sort(), /private key material/],
    [[...required, 'src/provider.ts'].sort(), /TypeScript source/],
    [[...required, 'runtime/crypto.cjs'].sort(), /unbundled CommonJS module/],
    [[...required].reverse(), /deterministic bytewise path order/],
    [required.filter((entry) => entry !== 'wasm/pqc.wasm'), /missing required entries/]
  ];

  for (const [listing, message] of invalidListings) {
    assert.throws(() => assertSecureArchiveEntries(listing.join('\n')), message);
  }

  assert.throws(
    () =>
      assertArchiveManifestEntryList(required, {
        schemaVersion: 1,
        entries: required.slice(1).map((entry) => ({ path: entry }))
      }),
    /does not match/
  );
});

test('detects bundled PQC WASM tampering against the committed SHA256SUMS entry', () => {
  const trustedBytes = Buffer.from('trusted pqc wasm fixture');
  const crypto = require('node:crypto');
  const trustedHash = crypto.createHash('sha256').update(trustedBytes).digest('hex');
  const sums = `${'11'.repeat(32)}  pqc.mjs\n${trustedHash}  pqc.wasm\n`;

  assert.equal(assertBundledPqcWasmHash(trustedBytes, sums), trustedHash);
  assert.throws(
    () => assertBundledPqcWasmHash(Buffer.from('tampered pqc wasm fixture'), sums),
    /hash mismatch/
  );
});
