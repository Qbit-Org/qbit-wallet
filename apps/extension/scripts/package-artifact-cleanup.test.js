/* eslint-env node */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getPackageArtifactName, removePackageArtifact } = require('./package-artifact-cleanup');

const extensionDir = path.resolve(__dirname, '..');
const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const gulpfileSource = fs.readFileSync(path.join(extensionDir, 'gulpfile.js'), 'utf8');
const packageTestSource = fs.readFileSync(path.join(__dirname, 'package-test.js'), 'utf8');

test('builds the exact package name for ZIP and XPI artifacts', () => {
  assert.equal(
    getPackageArtifactName({
      brandName: 'qbit',
      browser: 'chrome',
      manifest: 'mv3',
      artifactVersion: '0.1.0'
    }),
    'qbit-chrome-mv3-v0.1.0.zip'
  );
  assert.equal(
    getPackageArtifactName({
      brandName: 'qbit',
      browser: 'firefox',
      manifest: 'mv2',
      artifactVersion: '0.1.0-beta.1'
    }),
    'qbit-firefox-mv2-v0.1.0-beta.1.xpi'
  );
});

test('adds the channel to non-store artifact names', () => {
  const storeArtifact = getPackageArtifactName({
    brandName: 'qbit',
    browser: 'chrome',
    manifest: 'mv3',
    artifactVersion: '0.1.0',
    channel: 'store'
  });
  const e2eArtifact = getPackageArtifactName({
    brandName: 'qbit',
    browser: 'chrome',
    manifest: 'mv3',
    artifactVersion: '0.1.0',
    channel: 'e2e'
  });

  assert.equal(storeArtifact, 'qbit-chrome-mv3-v0.1.0.zip');
  assert.equal(e2eArtifact, 'qbit-chrome-mv3-e2e-v0.1.0.zip');
  assert.notEqual(e2eArtifact, storeArtifact);
});

test('rejects artifact components that could escape the dist directory', () => {
  assert.throws(
    () =>
      getPackageArtifactName({
        brandName: 'qbit',
        browser: 'chrome',
        manifest: 'mv3',
        artifactVersion: '0.1.0-../../outside'
      }),
    /artifactVersion must be a non-empty filename component/
  );
  assert.throws(
    () =>
      getPackageArtifactName({
        brandName: 'qbit',
        browser: '..\\outside',
        manifest: 'mv3',
        artifactVersion: '0.1.0'
      }),
    /browser must be a non-empty filename component/
  );
  assert.throws(
    () =>
      getPackageArtifactName({
        brandName: 'qbit',
        browser: 'chrome',
        manifest: 'mv3',
        artifactVersion: '0.1.0',
        channel: '../outside'
      }),
    /channel must be a non-empty filename component/
  );
});

test('removes a stale package artifact idempotently', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-package-cleanup-'));
  context.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));

  const artifactPath = path.join(temporaryDirectory, 'qbit-chrome-mv3-v0.1.0.zip');
  fs.writeFileSync(artifactPath, 'stale artifact');
  fs.writeFileSync(`${artifactPath}.manifest.json`, 'stale manifest');
  fs.writeFileSync(`${artifactPath}.sha256`, 'stale checksum');

  removePackageArtifact(artifactPath);
  assert.equal(fs.existsSync(artifactPath), false);
  assert.equal(fs.existsSync(`${artifactPath}.manifest.json`), false);
  assert.equal(fs.existsSync(`${artifactPath}.sha256`), false);
  assert.doesNotThrow(() => removePackageArtifact(artifactPath));
});

test('production and validated package builds remove their exact stale target first', () => {
  const taskClean = gulpfileSource.match(/function task_clean\(\) \{([\s\S]*?)\n\}/);

  assert.ok(taskClean, 'task_clean must remain present');
  assert.match(
    taskClean[1],
    /if \(options\.env == 'pro'\) \{\s*removePackageArtifact\(path\.join\(__dirname, 'dist', getArtifactName\(\)\)\);\s*\}/
  );
  assert.match(
    packageTestSource,
    /removePackageArtifact\(artifactPath\);\s+execFileSync\('corepack', \['pnpm'/
  );
});

test('invalid package build targets fail instead of accepting a stale artifact', () => {
  const invalidTargets = [
    ['--env=prod', /not supported env/],
    ['--browser=safari', /not supported browser/],
    ['--manifest=mv4', /not supported manifest/],
    ['--channel=nightly', /not supported channel/]
  ];

  for (const [argument, expectedError] of invalidTargets) {
    const result = spawnSync(corepackCommand, ['pnpm', 'exec', 'gulp', 'build', argument], {
      cwd: extensionDir,
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0, `${argument} must return a non-zero status`);
    assert.match(`${result.stdout}\n${result.stderr}`, expectedError);
  }
});
