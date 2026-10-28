/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FIXED_ARCHIVE_MTIME,
  REGULAR_FILE_MODE,
  buildArtifactManifest,
  createDeterministicArchiveInput,
  verifyArtifactManifests,
  writeArtifactManifests
} = require('./deterministic-package');

function vinyl(relative, mode, contents = Buffer.from(relative)) {
  return {
    contents,
    relative,
    stat: { mode, mtime: new Date() },
    isDirectory: () => false,
    isSymbolic: () => false
  };
}

async function runArchiveTransform(files) {
  const output = [];
  const transform = createDeterministicArchiveInput();
  transform.on('data', (file) => output.push(file));
  for (const file of files) {
    transform.write(file);
  }
  transform.end();
  await new Promise((resolve, reject) => {
    transform.on('end', resolve);
    transform.on('error', reject);
  });
  return output;
}

test('sorts package input by bytewise archive path and canonicalizes metadata', async () => {
  const files = await runArchiveTransform([
    vinyl('z-last.js', 0o100755),
    vinyl('nested/second.js', 0o100600),
    vinyl('A-first.js', 0o100664)
  ]);

  assert.deepEqual(
    files.map((file) => file.relative),
    ['A-first.js', 'nested/second.js', 'z-last.js']
  );
  for (const file of files) {
    assert.equal(file.stat.mode, REGULAR_FILE_MODE);
    assert.equal(file.stat.mtime, FIXED_ARCHIVE_MTIME);
  }
});

test('writes deterministic artifact and per-entry SHA-256 manifests', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-package-manifest-'));
  context.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));
  const contentDirectory = path.join(temporaryDirectory, 'content');
  const artifactPath = path.join(temporaryDirectory, 'qbit.zip');
  fs.mkdirSync(path.join(contentDirectory, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(contentDirectory, 'z.txt'), 'last');
  fs.writeFileSync(path.join(contentDirectory, 'nested', 'a.txt'), 'first');
  fs.writeFileSync(artifactPath, 'archive bytes');

  const first = writeArtifactManifests(artifactPath, contentDirectory);
  const firstManifestBytes = fs.readFileSync(first.manifestPath);
  const firstChecksumBytes = fs.readFileSync(first.sha256Path);
  const second = writeArtifactManifests(artifactPath, contentDirectory);

  assert.deepEqual(fs.readFileSync(second.manifestPath), firstManifestBytes);
  assert.deepEqual(fs.readFileSync(second.sha256Path), firstChecksumBytes);
  assert.deepEqual(
    second.manifest.entries.map((entry) => entry.path),
    ['nested/a.txt', 'z.txt']
  );
  assert.deepEqual(verifyArtifactManifests(artifactPath, contentDirectory), second.manifest);
});

test('verification rejects artifact and content tampering', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-package-tamper-'));
  context.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));
  const contentDirectory = path.join(temporaryDirectory, 'content');
  const artifactPath = path.join(temporaryDirectory, 'qbit.zip');
  fs.mkdirSync(contentDirectory);
  fs.writeFileSync(path.join(contentDirectory, 'background.js'), 'trusted');
  fs.writeFileSync(artifactPath, 'trusted archive');
  writeArtifactManifests(artifactPath, contentDirectory);

  fs.writeFileSync(artifactPath, 'tampered archive');
  assert.throws(
    () => verifyArtifactManifests(artifactPath, contentDirectory),
    /manifest does not match/
  );

  fs.writeFileSync(artifactPath, 'trusted archive');
  fs.writeFileSync(path.join(contentDirectory, 'background.js'), 'tampered');
  assert.throws(
    () => verifyArtifactManifests(artifactPath, contentDirectory),
    /manifest does not match/
  );
});

test('manifest content is independent of host file modes and mtimes', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-package-metadata-'));
  context.after(() => fs.rmSync(temporaryDirectory, { force: true, recursive: true }));
  const contentDirectory = path.join(temporaryDirectory, 'content');
  const artifactPath = path.join(temporaryDirectory, 'qbit.zip');
  fs.mkdirSync(contentDirectory);
  const contentPath = path.join(contentDirectory, 'background.js');
  fs.writeFileSync(contentPath, 'same bytes');
  fs.writeFileSync(artifactPath, 'same archive');
  const first = buildArtifactManifest(artifactPath, contentDirectory);

  fs.chmodSync(contentPath, 0o755);
  fs.utimesSync(contentPath, new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
  const second = buildArtifactManifest(artifactPath, contentDirectory);

  assert.deepEqual(second, first);
});
