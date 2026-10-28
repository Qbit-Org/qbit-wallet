/* eslint-env node */

const fs = require('node:fs');

function assertSafeArtifactComponent(name, value) {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty filename component`);
  }
}

function getPackageArtifactName({ brandName, browser, manifest, artifactVersion, channel = 'store' }) {
  Object.entries({ brandName, browser, manifest, artifactVersion, channel }).forEach(([name, value]) =>
    assertSafeArtifactComponent(name, value)
  );

  const extension = browser === 'firefox' ? 'xpi' : 'zip';
  const channelSuffix = channel === 'store' ? '' : `-${channel}`;
  return `${brandName}-${browser}-${manifest}${channelSuffix}-v${artifactVersion}.${extension}`;
}

function removePackageArtifact(artifactPath) {
  for (const packagePath of [artifactPath, `${artifactPath}.manifest.json`, `${artifactPath}.sha256`]) {
    fs.rmSync(packagePath, { force: true });
  }
}

module.exports = {
  getPackageArtifactName,
  removePackageArtifact
};
