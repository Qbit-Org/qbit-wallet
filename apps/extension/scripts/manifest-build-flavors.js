/* eslint-env node */

const { REGTEST_HOST_PERMISSION, REGTEST_ORIGIN } = require('./package-artifact-validation');

function appendConnectSource(contentSecurityPolicy, source) {
  if (typeof contentSecurityPolicy !== 'string') {
    throw new TypeError('MV3 e2e manifest must define an extension_pages CSP string');
  }

  const directives = contentSecurityPolicy
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean);
  const connectSrcIndex = directives.findIndex(
    (directive) => directive === 'connect-src' || directive.startsWith('connect-src ')
  );
  if (connectSrcIndex === -1) {
    throw new Error('MV3 e2e manifest must define a connect-src directive');
  }

  const connectSrc = directives[connectSrcIndex].split(/\s+/);
  if (!connectSrc.includes(source)) {
    connectSrc.push(source);
  }
  directives[connectSrcIndex] = connectSrc.join(' ');
  return directives.join('; ');
}

/**
 * E2E flavor: promote the loopback origin from an optional (runtime-requested)
 * permission to a required one so automation never has to answer a browser
 * prompt, and drop the now-duplicate optional entry. The CSP already carries
 * the exact origin in the shared base manifest; appending stays idempotent.
 */
function applyE2eMv3ManifestOverlay(manifest) {
  if (!Array.isArray(manifest.host_permissions)) {
    throw new TypeError('MV3 e2e manifest must define host_permissions');
  }

  const hostPermissions = [...manifest.host_permissions];
  if (!hostPermissions.includes(REGTEST_HOST_PERMISSION)) {
    hostPermissions.push(REGTEST_HOST_PERMISSION);
  }

  const { optional_host_permissions: optionalHostPermissions, ...rest } = manifest;
  const remainingOptional = Array.isArray(optionalHostPermissions)
    ? optionalHostPermissions.filter((entry) => entry !== REGTEST_HOST_PERMISSION)
    : [];

  return {
    ...rest,
    host_permissions: hostPermissions,
    ...(remainingOptional.length > 0 ? { optional_host_permissions: remainingOptional } : {}),
    content_security_policy: {
      ...manifest.content_security_policy,
      extension_pages: appendConnectSource(manifest.content_security_policy?.extension_pages, REGTEST_ORIGIN)
    }
  };
}

function mergeExtensionManifest({ baseManifest, browserManifest, version, channel }) {
  const result = Object.assign({}, baseManifest, browserManifest, { version });
  if (channel === 'e2e' && result.manifest_version === 3) {
    return applyE2eMv3ManifestOverlay(result);
  }
  return result;
}

module.exports = {
  applyE2eMv3ManifestOverlay,
  mergeExtensionManifest
};
