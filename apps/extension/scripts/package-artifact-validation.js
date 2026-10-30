/* eslint-env node */

const fs = require('node:fs');
const path = require('node:path');

const { bundledPhishingHostPermissions } = require('./phishing-host-permissions');

const REQUIRED_BUNDLE_ENTRIES = Object.freeze(['background.js', 'content-script.js', 'pageProvider.js', 'ui.js']);
// The page the phishing redirect rule sends a top-level navigation to, and
// its script.
const PHISHING_WARNING_PAGE = 'phishing-warning.html';
const REQUIRED_ARCHIVE_ENTRIES = Object.freeze([
  'manifest.json',
  ...REQUIRED_BUNDLE_ENTRIES,
  PHISHING_WARNING_PAGE,
  'phishing-warning.js',
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
const EXPECTED_MV3_INDEXER_HOST_PERMISSIONS = Object.freeze([
  'https://mempool.qbit.org/*',
  'https://mempool-testnet.qbit.org/*'
]);
// Host access to the bundled phishing denylist, one `*://*.<domain>/*` pattern
// per domain and its subdomains, generated at build from the denylist
// (scripts/phishing-host-permissions.js). The warning redirect rule fires only
// with host access to the blocked page; the content script's `<all_urls>`
// match already brings the all-sites install warning, so these add none. The
// reviewed list is pinned by its SHA-256 (the patterns joined by newlines) and
// length, so that the domains stay only in the reviewed denylist source: a
// denylist change fails packaging until it is reviewed and these are updated.
const EXPECTED_MV3_PHISHING_HOST_PERMISSIONS = Object.freeze(bundledPhishingHostPermissions());
const REVIEWED_PHISHING_HOST_PERMISSIONS_COUNT = 29;
const REVIEWED_PHISHING_HOST_PERMISSIONS_SHA256 = 'ede26b8e47d19b7057d06c90605fd85c46ceec30306fd3751bfc7e37bcff7c22';
// A dotted hostname and its subdomains, or an exact IPv4 or IPv6 address.
const PHISHING_HOST_PERMISSION_PATTERN =
  /^\*:\/\/(?:\*\.(?:[a-z0-9-]+\.)+[a-z0-9-]+|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])\/\*$/;
const EXPECTED_MV3_HOST_PERMISSIONS = Object.freeze([
  ...EXPECTED_MV3_INDEXER_HOST_PERMISSIONS,
  ...EXPECTED_MV3_PHISHING_HOST_PERMISSIONS
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

// Packaged text must not depend on the build machine: webpack can inline
// absolute module paths (e.g. `import.meta.url` as a file:// URL), which ships
// the builder's checkout path and breaks independent rebuilds (#338).
// Every other entry is scanned as text; these binary formats are not.
const BUILD_HOST_PATH_UNSCANNED_EXTENSIONS = Object.freeze([
  '.avif',
  '.bmp',
  '.eot',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.otf',
  '.png',
  '.ttf',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2'
]);
const FILE_URL_PATTERN = /file:\/\/\//i;
// A character that continues a file name, so `<entry>X` is not `<entry>`.
const FILE_NAME_CONTINUATION_PATTERN = /[\w.@+-]/;

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

// Describes each builder directory whose absolute paths must not be packaged.
// Only `<directory>/<entry>` for an existing entry counts, so a short checkout
// root such as `/app` does not match an unrelated route string like "/app".
function collectBuildHostDirectories(directories) {
  const buildHostDirectories = [];
  const seen = new Set();
  for (const { label, path: directory } of directories) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      continue;
    }
    const candidates = [path.resolve(directory)];
    try {
      candidates.push(fs.realpathSync(directory));
    } catch {
      // A directory that does not exist has no entries to leak.
    }
    for (const candidate of candidates) {
      if (candidate === path.parse(candidate).root || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      let entries;
      try {
        entries = new Set(fs.readdirSync(candidate));
      } catch {
        continue;
      }
      buildHostDirectories.push({ label, prefix: `${candidate}/`, entries });
    }
  }
  return buildHostDirectories;
}

function assertNoBuildHostPaths(entryPath, contents, buildHostDirectories) {
  if (BUILD_HOST_PATH_UNSCANNED_EXTENSIONS.includes(path.posix.extname(entryPath).toLowerCase())) {
    return;
  }
  const text = Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents);
  if (FILE_URL_PATTERN.test(text)) {
    throw new Error(`artifact entry contains an absolute file:// URL: ${entryPath}`);
  }
  for (const { label, prefix, entries } of buildHostDirectories) {
    for (let index = text.indexOf(prefix); index !== -1; index = text.indexOf(prefix, index + 1)) {
      const start = index + prefix.length;
      for (const entry of entries) {
        if (text.startsWith(entry, start) && !FILE_NAME_CONTINUATION_PATTERN.test(text.charAt(start + entry.length))) {
          throw new Error(`artifact entry contains the ${label} ${prefix}${entry}: ${entryPath}`);
        }
      }
    }
  }
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
  assertReviewedPhishingHostPermissions(EXPECTED_MV3_PHISHING_HOST_PERMISSIONS);
  // The reviewed phishing patterns name a subdomain wildcard and every scheme,
  // which the broad-host check rejects anywhere else.
  assertNoForbiddenHosts(
    'host_permissions',
    Array.isArray(manifest.host_permissions)
      ? manifest.host_permissions.filter((entry) => !EXPECTED_MV3_PHISHING_HOST_PERMISSIONS.includes(entry))
      : manifest.host_permissions
  );
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
  if (!Array.isArray(webAccessibleResources) || webAccessibleResources.length !== 2) {
    throw new Error('release manifest must define exactly two web-accessible resource groups');
  }
  assertExactArray(
    'web_accessible_resources[0].resources',
    webAccessibleResources[0].resources,
    ['pageProvider.js']
  );
  assertExactArray('web_accessible_resources[0].matches', webAccessibleResources[0].matches, [
    '<all_urls>'
  ]);
  // The warning page must be web-accessible for the redirect rule to reach it
  // from any site's redirect chain. A dynamic URL keeps websites from opening
  // or framing it by the extension's fixed id.
  const warningPageGroup = webAccessibleResources[1];
  assertExactArray('web_accessible_resources[1] keys', Object.keys(warningPageGroup ?? {}).sort(), [
    'matches',
    'resources',
    'use_dynamic_url'
  ]);
  assertExactArray('web_accessible_resources[1].resources', warningPageGroup.resources, [PHISHING_WARNING_PAGE]);
  assertExactArray('web_accessible_resources[1].matches', warningPageGroup.matches, ['<all_urls>']);
  if (warningPageGroup.use_dynamic_url !== true) {
    throw new Error('web_accessible_resources[1] must use a dynamic URL');
  }

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

/**
 * Throws unless the phishing host permissions are the reviewed list: its
 * length and SHA-256, and each one a subdomain pattern for a dotted hostname
 * or an exact IP address.
 */
function assertReviewedPhishingHostPermissions(patterns) {
  if (!Array.isArray(patterns) || patterns.length !== REVIEWED_PHISHING_HOST_PERMISSIONS_COUNT) {
    throw new Error('phishing host_permissions do not match the reviewed release allowlist');
  }
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !PHISHING_HOST_PERMISSION_PATTERN.test(pattern)) {
      throw new Error(`phishing host_permissions contain an unreviewed pattern: ${pattern}`);
    }
  }
  const crypto = require('node:crypto');
  const digest = crypto.createHash('sha256').update(patterns.join('\n')).digest('hex');
  if (digest !== REVIEWED_PHISHING_HOST_PERMISSIONS_SHA256) {
    throw new Error(
      'phishing host_permissions do not match the reviewed release allowlist; review the denylist change and update its count and SHA-256'
    );
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
  BUILD_HOST_PATH_UNSCANNED_EXTENSIONS,
  E2E_REGTEST_HOST_PERMISSION,
  E2E_REGTEST_ORIGIN,
  EXPECTED_MV3_CSP,
  EXPECTED_MV3_HOST_PERMISSIONS,
  EXPECTED_MV3_INDEXER_HOST_PERMISSIONS,
  EXPECTED_MV3_OPTIONAL_HOST_PERMISSIONS,
  EXPECTED_MV3_PERMISSIONS,
  EXPECTED_MV3_PHISHING_HOST_PERMISSIONS,
  FORBIDDEN_HOST_PATTERNS,
  FORBIDDEN_PACKAGE_PATH_PATTERNS,
  REGTEST_HOST_PERMISSION,
  REGTEST_ORIGIN,
  REQUIRED_ARCHIVE_ENTRIES,
  REQUIRED_BUNDLE_ENTRIES,
  assertArchiveManifestEntryList,
  assertBundledPqcWasmHash,
  assertNoBuildHostPaths,
  assertReviewedPhishingHostPermissions,
  assertRequiredBundleEntries,
  assertSecureArchiveEntries,
  assertNoForbiddenHosts,
  assertSecureMv3Manifest,
  collectBuildHostDirectories,
  parseArchiveEntries
};
