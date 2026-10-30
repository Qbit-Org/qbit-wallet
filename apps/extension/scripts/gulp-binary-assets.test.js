/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const test = require('node:test');

const gulp = require('gulp');

const extensionDir = path.resolve(__dirname, '..');
const gulpfileSource = fs.readFileSync(path.join(extensionDir, 'gulpfile.js'), 'utf8');
const binaryAssetPattern = /\.(?:ico|otf|png|wasm|woff2?|zip)$/i;

function taskSource(name) {
  const task = gulpfileSource.match(new RegExp(`function ${name}\\((?:cb)?\\) \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(task, `${name} must remain present`);
  return task[1];
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

test('the tasks that copy build assets or package the extension read files as raw bytes', () => {
  for (const name of ['task_prepare', 'task_package']) {
    assert.match(taskSource(name), /gulp\s*\.src\([^)]*\{[^}]*encoding: false[^}]*\}\)/, name);
  }
});

test('Gulp copies every binary build asset byte for byte when it reads raw bytes', async () => {
  const rawDir = path.join(extensionDir, 'build', '_raw');
  const binaryAssets = listFiles(rawDir).filter((file) => binaryAssetPattern.test(file));
  assert.ok(binaryAssets.length > 0, 'build/_raw must contain binary assets');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-gulp-binary-'));
  try {
    await pipeline(gulp.src('build/_raw/**/*', { cwd: extensionDir, encoding: false }), gulp.dest(outputDir));

    for (const asset of binaryAssets) {
      const copied = path.join(outputDir, path.relative(rawDir, asset));
      assert.ok(fs.readFileSync(copied).equals(fs.readFileSync(asset)), path.relative(extensionDir, asset));
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
