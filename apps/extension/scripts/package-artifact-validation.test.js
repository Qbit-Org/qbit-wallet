/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BUILD_HOST_PATH_UNSCANNED_EXTENSIONS,
  E2E_REGTEST_HOST_PERMISSION,
  E2E_REGTEST_ORIGIN,
  EXPECTED_MV3_CSP,
  EXPECTED_MV3_HOST_PERMISSIONS,
  EXPECTED_MV3_INDEXER_HOST_PERMISSIONS,
  EXPECTED_MV3_OPTIONAL_HOST_PERMISSIONS,
  EXPECTED_MV3_PERMISSIONS,
  EXPECTED_MV3_PHISHING_HOST_PERMISSIONS,
  REGTEST_HOST_PERMISSION,
  REGTEST_ORIGIN,
  assertArchiveManifestEntryList,
  assertBundledPqcWasmHash,
  assertNoBuildHostPaths,
  assertReviewedPhishingHostPermissions,
  assertNoForbiddenHosts,
  assertRequiredBundleEntries,
  assertSecureArchiveEntries,
  assertSecureMv3Manifest,
  collectBuildHostDirectories,
  parseArchiveEntries
} = require('./package-artifact-validation');
const { mergeExtensionManifest } = require('./manifest-build-flavors');
const { bundledPhishingHostPermissions, phishingHostPermissions } = require('./phishing-host-permissions');

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
      },
      {
        resources: ['phishing-warning.html'],
        matches: ['<all_urls>'],
        use_dynamic_url: true
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

test('host access is the explorers plus exactly the bundled phishing denylist, generated at build', () => {
  const { BUNDLED_PHISHING_DENYLIST } = require('@qbit/phishing-detect');

  // The build derives the patterns from the denylist; the reviewed policy pins
  // their count and digest, so a denylist change fails here until the policy
  // is updated too.
  const generated = bundledPhishingHostPermissions();
  assert.deepEqual(generated, EXPECTED_MV3_PHISHING_HOST_PERMISSIONS);
  assert.equal(generated.length, BUNDLED_PHISHING_DENYLIST.length);
  assert.deepEqual(
    generated,
    BUNDLED_PHISHING_DENYLIST.map((domain) => `*://*.${domain}/*`)
  );
  assert.doesNotThrow(() => assertReviewedPhishingHostPermissions(generated));
  assert.deepEqual(EXPECTED_MV3_HOST_PERMISSIONS, [
    ...EXPECTED_MV3_INDEXER_HOST_PERMISSIONS,
    ...EXPECTED_MV3_PHISHING_HOST_PERMISSIONS
  ]);

  const baseManifest = readJson('build/_raw/manifest/_base_v3.json');
  assert.deepEqual(baseManifest.host_permissions, EXPECTED_MV3_INDEXER_HOST_PERMISSIONS);
  assert.deepEqual(currentChromeMv3Manifest('store').host_permissions, EXPECTED_MV3_HOST_PERMISSIONS);
  assert.deepEqual(currentChromeMv3Manifest('e2e').host_permissions, [
    ...EXPECTED_MV3_HOST_PERMISSIONS,
    REGTEST_HOST_PERMISSION
  ]);
});

test('phishing host patterns follow the DNR form of each denylist entry and skip what DNR cannot name', () => {
  assert.deepEqual(phishingHostPermissions(['Example.COM.', 'a.example.org', 'example.com', 'bad host', '', 7]), [
    '*://*.example.com/*',
    '*://*.a.example.org/*'
  ]);
});

test('the reviewed phishing host permissions reject a changed, added, dropped, or broadened entry', () => {
  const reviewed = [...EXPECTED_MV3_PHISHING_HOST_PERMISSIONS];
  const changes = [
    ['a changed entry', [...reviewed.slice(0, -1), '*://*.example.com/*'], /reviewed release allowlist/],
    ['an added entry', [...reviewed, '*://*.example.com/*'], /reviewed release allowlist/],
    ['a dropped entry', reviewed.slice(1), /reviewed release allowlist/],
    ['a reordered list', [...reviewed].reverse(), /reviewed release allowlist/],
    ['a bare suffix', [...reviewed.slice(0, -1), '*://*.com/*'], /unreviewed pattern/],
    ['all hosts', [...reviewed.slice(0, -1), '*://*/*'], /unreviewed pattern/],
    ['an exact host only', [...reviewed.slice(0, -1), 'https://example.com/*'], /unreviewed pattern/],
    // The form an IP entry takes is accepted, but it is not the reviewed list.
    ['an unreviewed IP entry', [...reviewed.slice(0, -1), '*://203.0.112.7/*'], /reviewed release allowlist;/],
    ['an unreviewed IPv6 entry', [...reviewed.slice(0, -1), '*://[2001:db8::1]/*'], /reviewed release allowlist;/]
  ];
  for (const [label, patterns, message] of changes) {
    assert.throws(() => assertReviewedPhishingHostPermissions(patterns), message, label);
  }
});

test('rejects any host pattern beyond the reviewed explorers and phishing denylist', () => {
  const mutations = [
    {
      label: 'another subdomain wildcard',
      mutate: (manifest) => manifest.host_permissions.push('*://*.example.com/*')
    },
    {
      label: 'a phishing pattern widened to all hosts',
      mutate: (manifest) => manifest.host_permissions.splice(2, 1, '*://*/*')
    },
    {
      label: 'a dropped phishing pattern',
      mutate: (manifest) => manifest.host_permissions.pop()
    },
    {
      label: 'phishing access requested optionally instead',
      mutate: (manifest) => manifest.optional_host_permissions.push(EXPECTED_MV3_PHISHING_HOST_PERMISSIONS[0])
    }
  ];
  for (const { label, mutate } of mutations) {
    const manifest = currentChromeMv3Manifest('store');
    mutate(manifest);
    assert.throws(() => assertSecureMv3Manifest(manifest), /host_permissions/, label);
  }
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
      label: 'wallet page exposed beside the warning page',
      mutate: (manifest) => manifest.web_accessible_resources[1].resources.push('index.html'),
      message: /web_accessible_resources\[1\]\.resources/
    },
    {
      label: 'warning page reachable by its fixed URL',
      mutate: (manifest) => {
        delete manifest.web_accessible_resources[1].use_dynamic_url;
      },
      message: /web_accessible_resources\[1\]/
    },
    {
      label: 'warning page with a static URL flag',
      mutate: (manifest) => {
        manifest.web_accessible_resources[1].use_dynamic_url = false;
      },
      message: /dynamic URL/
    },
    {
      label: 'warning page exposed to other extensions',
      mutate: (manifest) => {
        manifest.web_accessible_resources[1].extension_ids = ['*'];
      },
      message: /web_accessible_resources\[1\] keys/
    },
    {
      label: 'missing warning page group',
      mutate: (manifest) => manifest.web_accessible_resources.pop(),
      message: /two web-accessible resource groups/
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
    'phishing-warning.html',
    'phishing-warning.js',
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
    'phishing-warning.html',
    'phishing-warning.js',
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
    [required.filter((entry) => entry !== 'wasm/pqc.wasm'), /missing required entries/],
    [required.filter((entry) => entry !== 'phishing-warning.html'), /missing required entries: phishing-warning\.html/]
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

function buildHostFixture(context) {
  const temporaryDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-build-host-')));
  context.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));
  const home = path.join(temporaryDirectory, 'home');
  const checkout = path.join(home, 'qbit-wallet');
  fs.mkdirSync(path.join(checkout, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cache'));
  fs.mkdirSync(path.join(home, 'Google Drive (work)'));
  return { temporaryDirectory, home, checkout };
}

test('rejects packaged text that embeds an absolute file:// module URL (#338)', () => {
  // The shape webpack produced for @qbit-oss/pqc in the 1.0.5 CI artifact.
  const leakedBundle = Buffer.from(
    'var o=e("file:///home/runner/_work/qbit-wallet/qbit-wallet/node_modules/@qbit-oss/pqc/wasm/pqc.mjs")'
  );

  assert.throws(
    () => assertNoBuildHostPaths('background.js', leakedBundle, []),
    /absolute file:\/\/ URL: background\.js/
  );
  assert.throws(() => assertNoBuildHostPaths('ui.html', 'href="FILE:///tmp/x"', []), /file:\/\/ URL/);
  assert.doesNotThrow(() =>
    assertNoBuildHostPaths('background.js', 'e.startsWith("file:")||e.startsWith("file://")', [])
  );
});

test('rejects the builder checkout path and home directory without a file:// scheme', (context) => {
  const { home, checkout } = buildHostFixture(context);
  const buildHostDirectories = collectBuildHostDirectories([
    { label: 'builder checkout path', path: checkout },
    { label: 'builder home directory', path: home }
  ]);

  assert.throws(
    () =>
      assertNoBuildHostPaths(
        'background.js',
        `var u="${checkout}/node_modules/@qbit-oss/pqc/wasm/pqc.mjs"`,
        buildHostDirectories
      ),
    new RegExp(`builder checkout path ${checkout}/node_modules: background\\.js`)
  );
  assert.throws(
    () => assertNoBuildHostPaths('chunk.1.js', `"${home}/.cache/babel-loader/x.json"`, buildHostDirectories),
    /builder home directory .*\/\.cache: chunk\.1\.js/
  );
  assert.throws(
    () => assertNoBuildHostPaths('ui.js', `"${home}/Google Drive (work)/qbit-wallet/x.js"`, buildHostDirectories),
    /builder home directory .*\/Google Drive \(work\): ui\.js/
  );
});

test('only flags existing entries below a builder directory, so short roots do not match routes', (context) => {
  const { checkout } = buildHostFixture(context);
  const buildHostDirectories = collectBuildHostDirectories([{ label: 'builder checkout path', path: checkout }]);

  // A container checkout at e.g. /app must not reject the UI's "/app" route.
  assert.doesNotThrow(() =>
    assertNoBuildHostPaths(
      'ui.js',
      `{path:"${checkout}"},{path:"${checkout}/settings"},"${checkout}/node_modulesX"`,
      buildHostDirectories
    )
  );
  assert.throws(
    () => assertNoBuildHostPaths('ui.js', `"${checkout}/node_modules"`, buildHostDirectories),
    /builder checkout path/
  );
});

test('resolves symlinked builder directories and ignores unusable home values', (context) => {
  const { temporaryDirectory, checkout } = buildHostFixture(context);
  const linkedCheckout = path.join(temporaryDirectory, 'linked-checkout');
  fs.symlinkSync(checkout, linkedCheckout, 'dir');

  const buildHostDirectories = collectBuildHostDirectories([
    { label: 'builder checkout path', path: linkedCheckout },
    { label: 'builder home directory', path: '/' },
    { label: 'builder home directory', path: '' },
    { label: 'builder home directory', path: undefined },
    { label: 'builder home directory', path: 'relative/home' },
    { label: 'builder home directory', path: path.join(temporaryDirectory, 'missing') }
  ]);

  assert.deepEqual(
    buildHostDirectories.map(({ prefix }) => prefix),
    [`${linkedCheckout}/`, `${checkout}/`]
  );
  // Webpack records resolved (real) module paths, so the real path must be caught.
  assert.throws(
    () => assertNoBuildHostPaths('background.js', `"${checkout}/node_modules/x.js"`, buildHostDirectories),
    /builder checkout path/
  );
  assert.doesNotThrow(() => assertNoBuildHostPaths('background.js', '"/usr/lib/x.js","/"', buildHostDirectories));
});

test('scans every packaged entry except binary images, fonts and WASM', (context) => {
  const { checkout } = buildHostFixture(context);
  const buildHostDirectories = collectBuildHostDirectories([{ label: 'builder checkout path', path: checkout }]);
  const leak = Buffer.from(`file:///x ${checkout}/node_modules/x`);

  for (const entry of [
    'background.js',
    'background.js.LICENSE.txt',
    'chunk.1.mjs',
    'popup.html',
    'static/css/ui.css',
    '_locales/en/messages.json',
    'images/logo.svg',
    'site.webmanifest',
    'README.md',
    'LICENSE'
  ]) {
    assert.throws(() => assertNoBuildHostPaths(entry, leak, buildHostDirectories), /file:\/\/ URL/, entry);
  }
  for (const entry of ['wasm/pqc.wasm', 'images/icon-128.png', 'images/ICON.PNG', 'fonts/x.woff2', 'x.otf']) {
    assert.ok(BUILD_HOST_PATH_UNSCANNED_EXTENSIONS.includes(path.posix.extname(entry).toLowerCase()), entry);
    assert.doesNotThrow(() => assertNoBuildHostPaths(entry, leak, buildHostDirectories), entry);
  }
});

test('package:test scans every packaged entry against the checkout and home directories', () => {
  const packageTestSource = fs.readFileSync(path.join(__dirname, 'package-test.js'), 'utf8');
  const directories = packageTestSource.match(/collectBuildHostDirectories\(\[([\s\S]*?)\]\)/);
  const entryLoop = packageTestSource.match(/for \(const entry of artifactManifest\.entries\) \{([\s\S]*?)\n {2}\}/);

  assert.ok(directories, 'package:test must collect the builder directories');
  assert.match(packageTestSource, /const repoRoot = path\.resolve\(extensionDir, '\.\.\/\.\.'\);/);
  for (const directory of [/path: repoRoot\b/, /path: os\.homedir\(\)/, /path: process\.env\.HOME\b/]) {
    assert.match(directories[1], directory);
  }
  assert.ok(entryLoop, 'package:test must verify every packaged entry');
  assert.match(entryLoop[1], /assertNoBuildHostPaths\(entry\.path, contents, buildHostDirectories\)/);
});
