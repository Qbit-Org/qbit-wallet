/* eslint-env node */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');

// ZIP stores a local DOS timestamp with a 1980 lower bound. Constructing this
// in local time makes the encoded fields identical in every host timezone.
const FIXED_ARCHIVE_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);
const REGULAR_FILE_MODE = 0o100644;

function compareArchivePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeArchivePath(value) {
  return value.split(path.sep).join('/');
}

function createDeterministicArchiveInput() {
  const files = [];

  return new Transform({
    objectMode: true,
    transform(file, _encoding, callback) {
      if (typeof file.isSymbolic === 'function' && file.isSymbolic()) {
        callback(new Error(`symbolic links are forbidden in extension packages: ${file.relative}`));
        return;
      }
      if (typeof file.isDirectory === 'function' && file.isDirectory()) {
        callback();
        return;
      }
      files.push(file);
      callback();
    },
    flush(callback) {
      files.sort((left, right) =>
        compareArchivePaths(normalizeArchivePath(left.relative), normalizeArchivePath(right.relative))
      );
      for (const file of files) {
        file.stat = {
          ...(file.stat || {}),
          mode: REGULAR_FILE_MODE,
          mtime: FIXED_ARCHIVE_MTIME
        };
        this.push(file);
      }
      callback();
    }
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function listContentFiles(contentDirectory) {
  const root = path.resolve(contentDirectory);
  const files = [];

  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort(compareArchivePaths)) {
      const absolutePath = path.join(directory, name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`symbolic links are forbidden in extension packages: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`unsupported extension package entry: ${absolutePath}`);
      }
      files.push({
        absolutePath,
        path: normalizeArchivePath(path.relative(root, absolutePath))
      });
    }
  }

  visit(root);
  return files;
}

function buildArtifactManifest(artifactPath, contentDirectory) {
  const artifactBuffer = fs.readFileSync(artifactPath);
  const entries = listContentFiles(contentDirectory).map((entry) => {
    const contents = fs.readFileSync(entry.absolutePath);
    return {
      path: entry.path,
      sha256: sha256(contents),
      size: contents.length
    };
  });

  return {
    schemaVersion: 1,
    artifact: {
      file: path.basename(artifactPath),
      sha256: sha256(artifactBuffer),
      size: artifactBuffer.length
    },
    entries
  };
}

function writeArtifactManifests(artifactPath, contentDirectory) {
  const manifest = buildArtifactManifest(artifactPath, contentDirectory);
  const manifestPath = `${artifactPath}.manifest.json`;
  const sha256Path = `${artifactPath}.sha256`;

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  fs.writeFileSync(sha256Path, `${manifest.artifact.sha256}  ${manifest.artifact.file}\n`, {
    mode: 0o644
  });
  return { manifest, manifestPath, sha256Path };
}

function verifyArtifactManifests(artifactPath, contentDirectory) {
  const expected = buildArtifactManifest(artifactPath, contentDirectory);
  const manifestPath = `${artifactPath}.manifest.json`;
  const sha256Path = `${artifactPath}.sha256`;
  const actual = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const checksum = fs.readFileSync(sha256Path, 'utf8');

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('extension artifact manifest does not match the package bytes');
  }
  const expectedChecksum = `${expected.artifact.sha256}  ${expected.artifact.file}\n`;
  if (checksum !== expectedChecksum) {
    throw new Error('extension artifact SHA-256 sidecar does not match the package bytes');
  }
  return expected;
}

module.exports = {
  FIXED_ARCHIVE_MTIME,
  REGULAR_FILE_MODE,
  buildArtifactManifest,
  createDeterministicArchiveInput,
  verifyArtifactManifests,
  writeArtifactManifests
};
