/* eslint-env node */

const REQUIRED_BUNDLE_ENTRIES = Object.freeze(['background.js', 'content-script.js', 'pageProvider.js', 'ui.js']);
const REQUIRED_ARCHIVE_ENTRIES = Object.freeze([
  'manifest.json',
  ...REQUIRED_BUNDLE_ENTRIES,
  'wasm/pqc.wasm'
]);
const EXPECTED_MV3_PERMISSIONS = Object.freeze([
  'storage',
  'unlimitedStorage',
  'declarativeNetRequest',
  'sidePanel'
]);
// Exact loopback origin of the developer-run regtest indexer. The store flavor
// declares it as an *optional* host permission (requested only from the
// wallet's own opt-in UI); the E2E flavor promotes it to a required permission.
// Keep in sync with QBIT_REGTEST_ORIGIN in packages/wallet-shared.
const REGTEST_ORIGIN = 'http://127.0.0.1:3002';
const REGTEST_HOST_PERMISSION = `${REGTEST_ORIGIN}/*`;
const E2E_REGTEST_ORIGIN = REGTEST_ORIGIN;
const E2E_REGTEST_HOST_PERMISSION = REGTEST_HOST_PERMISSION;
const EXPECTED_MV3_HOST_PERMISSIONS = Object.freeze([
  'https://mempool.qbit.org/*',
  'https://mempool-testnet.qbit.org/*'
]);
const EXPECTED_MV3_OPTIONAL_HOST_PERMISSIONS = Object.freeze([REGTEST_HOST_PERMISSION]);
const EXPECTED_MV3_CSP = [
  "script-src 'self' 'wasm-unsafe-eval'",
  "object-src 'none'",
  ["connect-src 'self'", 'https://mempool.qbit.org', 'https://mempool-testnet.qbit.org', REGTEST_ORIGIN].join(' ')
].join('; ');
// Host patterns that must never appear in any permission list or connect-src,
// regardless of the exact-allowlist checks: wildcard schemes/hosts, unscoped
// loopback ports, hostnames that resolve outside the reviewed literal, and
// anything that is not the exact reviewed port.
const FORBIDDEN_HOST_PATTERNS = Object.freeze([
  { label: 'all-URL host access', pattern: /^<all_urls>$/i },
  { label: 'wildcard scheme or host', pattern: /^(?:\*|https?|ws|wss|ftp):\/\/\*/i },
  { label: 'wildcard scheme', pattern: /^\*:\/\//i },
  { label: 'scheme-wide source', pattern: /^(?:https?|wss?|ftp|data|blob|filesystem):$/i },
  { label: 'localhost hostname', pattern: /^(?:https?|wss?):\/\/localhost(?::\d+|:\*)?(?:\/|$)/i },
  { label: 'unscoped loopback port', pattern: /^(?:https?|wss?):\/\/127\.0\.0\.1(?::\*)?(?:\/|$)/i },
  { label: 'unscoped loopback range', pattern: /^(?:https?|wss?):\/\/127\.\*/i },
  { label: 'IPv6 loopback', pattern: /^(?:https?|wss?):\/\/\[::1\]/i },
  { label: 'non-reviewed loopback port', pattern: /^(?:https?|wss?):\/\/127\.0\.0\.1:(?!3002(?:\/|$))\d+/i }
]);
const FORBIDDEN_PACKAGE_PATH_PATTERNS = Object.freeze([
  { label: 'source map', pattern: /\.map$/i },
  { label: 'TypeScript source', pattern: /\.(?:ts|tsx)$/i },
  { label: 'unbundled CommonJS module', pattern: /\.cjs$/i },
  { label: 'environment file', pattern: /(?:^|\/)\.env(?:\.|$)/i },
  { label: 'private key material', pattern: /\.(?:key|pem|p12|pfx)$/i },
  { label: 'dependency tree', pattern: /(?:^|\/)node_modules(?:\/|$)/i },
  { label: 'test source', pattern: /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i },
  { label: 'repository metadata', pattern: /(?:^|\/)\.git(?:\/|$)/i }
]);

function parseArchiveEntries(commandOutput) {
  if (typeof commandOutput !== 'string' && !Buffer.isBuffer(commandOutput)) {
    throw new TypeError('archive listing output must be a string or Buffer');
  }

  return commandOutput
    .toString('utf8')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((entry) => entry.length > 0);
}

function assertRequiredBundleEntries(commandOutput) {
  const archiveEntries = new Set(parseArchiveEntries(commandOutput));
  const missingEntries = REQUIRED_BUNDLE_ENTRIES.filter((entry) => !archiveEntries.has(entry));

  if (missingEntries.length > 0) {
    throw new Error(`artifact is missing required bundle entries: ${missingEntries.join(', ')}`);
  }
}

function assertSecureArchiveEntries(commandOutput) {
  const entries = parseArchiveEntries(commandOutput);
  const seen = new Set();

  for (const entry of entries) {
    if (
      entry.includes('\0') ||
      entry.includes('\\') ||
      entry.startsWith('/') ||
      /^[a-z]:/i.test(entry) ||
      entry.split('/').some((component) => component === '.' || component === '..')
    ) {
      throw new Error(`artifact contains unsafe archive path: ${entry}`);
    }
    if (seen.has(entry)) {
      throw new Error(`artifact contains duplicate archive path: ${entry}`);
    }
    seen.add(entry);

    for (const rule of FORBIDDEN_PACKAGE_PATH_PATTERNS) {
      if (rule.pattern.test(entry)) {
        throw new Error(`artifact contains forbidden ${rule.label}: ${entry}`);
      }
    }
  }

  const missingEntries = REQUIRED_ARCHIVE_ENTRIES.filter((entry) => !seen.has(entry));
  if (missingEntries.length > 0) {
    throw new Error(`artifact is missing required entries: ${missingEntries.join(', ')}`);
  }

  const sortedEntries = [...entries].sort(compareArchivePaths);
  if (entries.some((entry, index) => entry !== sortedEntries[index])) {
    throw new Error('artifact entries are not in deterministic bytewise path order');
  }
  return entries;
}

function assertArchiveManifestEntryList(entries, artifactManifest) {
  if (!artifactManifest || artifactManifest.schemaVersion !== 1) {
    throw new Error('artifact manifest has an unsupported schema');
  }
  const manifestEntries = artifactManifest.entries;
  if (!Array.isArray(manifestEntries)) {
    throw new Error('artifact manifest entries must be an array');
  }
  const manifestPaths = manifestEntries.map((entry) => entry?.path);
  if (
    entries.length !== manifestPaths.length ||
    entries.some((entry, index) => entry !== manifestPaths[index])
  ) {
    throw new Error('artifact entry list does not match its SHA-256 manifest');
  }
}

function assertBundledPqcWasmHash(wasmBytes, sha256Sums) {
  if (!Buffer.isBuffer(wasmBytes)) {
    throw new TypeError('bundled PQC WASM must be provided as a Buffer');
  }
  if (typeof sha256Sums !== 'string') {
    throw new TypeError('PQC SHA256SUMS must be provided as text');
  }
  const expectedLine = sha256Sums
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .find((line) => /^\s*[0-9a-f]{64}\s+\*?pqc\.wasm\s*$/.test(line));
  if (!expectedLine) {
    throw new Error('PQC SHA256SUMS does not contain pqc.wasm');
  }
  const expected = expectedLine.trim().split(/\s+/)[0];
  const crypto = require('node:crypto');
  const actual = crypto.createHash('sha256').update(wasmBytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`bundled PQC WASM hash mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function compareArchivePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertSecureMv3Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('extension manifest must be an object');
  }
  if (manifest.manifest_version !== 3) {
    throw new Error('release artifact must use Manifest V3');
  }
  assertExactArray('permissions', manifest.permissions, EXPECTED_MV3_PERMISSIONS);
  assertNoForbiddenHosts('host_permissions', manifest.host_permissions);
  assertExactArray('host_permissions', manifest.host_permissions, EXPECTED_MV3_HOST_PERMISSIONS);
  assertNoForbiddenHosts('optional_host_permissions', manifest.optional_host_permissions);
  assertExactArray(
    'optional_host_permissions',
    manifest.optional_host_permissions,
    EXPECTED_MV3_OPTIONAL_HOST_PERMISSIONS
  );
  if (manifest.host_permissions.some((entry) => manifest.optional_host_permissions.includes(entry))) {
    throw new Error('host_permissions and optional_host_permissions must not overlap');
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'optional_permissions')) {
    throw new Error('optional_permissions is forbidden; the only optional capability is the reviewed loopback origin');
  }

  if (Object.prototype.hasOwnProperty.call(manifest, 'externally_connectable')) {
    throw new Error('externally_connectable is forbidden without an authenticated external listener');
  }

  const contentScripts = manifest.content_scripts;
  if (!Array.isArray(contentScripts) || contentScripts.length !== 1) {
    throw new Error('release manifest must define exactly one content script');
  }
  const contentScript = contentScripts[0];
  assertExactArray('content_scripts[0].matches', contentScript.matches, ['<all_urls>']);
  assertExactArray('content_scripts[0].js', contentScript.js, ['content-script.js']);
  if (contentScript.run_at !== 'document_start') {
    throw new Error('content script must run at document_start');
  }
  if (contentScript.all_frames === true) {
    throw new Error('content script must not run in untrusted child frames');
  }

  const webAccessibleResources = manifest.web_accessible_resources;
  if (!Array.isArray(webAccessibleResources) || webAccessibleResources.length !== 1) {
    throw new Error('release manifest must define exactly one web-accessible resource group');
  }
  assertExactArray(
    'web_accessible_resources[0].resources',
    webAccessibleResources[0].resources,
    ['pageProvider.js']
  );
  assertExactArray('web_accessible_resources[0].matches', webAccessibleResources[0].matches, [
    '<all_urls>'
  ]);

  const csp = manifest.content_security_policy?.extension_pages;
  if (typeof csp === 'string') {
    for (const directive of csp.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name === 'connect-src') {
        assertNoForbiddenHosts('CSP connect-src', sources);
        if (!sources.includes(REGTEST_ORIGIN)) {
          throw new Error('CSP connect-src must contain the exact reviewed loopback origin');
        }
      }
    }
  }
  if (csp !== EXPECTED_MV3_CSP) {
    throw new Error('extension page CSP does not match the reviewed release allowlist');
  }
}

function assertNoForbiddenHosts(name, entries) {
  if (!Array.isArray(entries)) {
    throw new Error(`${name} does not match the reviewed release allowlist`);
  }
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new Error(`${name} contains a non-string entry`);
    }
    for (const rule of FORBIDDEN_HOST_PATTERNS) {
      if (rule.pattern.test(entry)) {
        throw new Error(`${name} contains forbidden ${rule.label}: ${entry}`);
      }
    }
  }
}

function assertExactArray(name, actual, expected) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${name} does not match the reviewed release allowlist`);
  }
}

module.exports = {
  E2E_REGTEST_HOST_PERMISSION,
  E2E_REGTEST_ORIGIN,
  EXPECTED_MV3_CSP,
  EXPECTED_MV3_HOST_PERMISSIONS,
  EXPECTED_MV3_OPTIONAL_HOST_PERMISSIONS,
  EXPECTED_MV3_PERMISSIONS,
  FORBIDDEN_HOST_PATTERNS,
  FORBIDDEN_PACKAGE_PATH_PATTERNS,
  REGTEST_HOST_PERMISSION,
  REGTEST_ORIGIN,
  REQUIRED_ARCHIVE_ENTRIES,
  REQUIRED_BUNDLE_ENTRIES,
  assertArchiveManifestEntryList,
  assertBundledPqcWasmHash,
  assertRequiredBundleEntries,
  assertSecureArchiveEntries,
  assertNoForbiddenHosts,
  assertSecureMv3Manifest,
  parseArchiveEntries
};
