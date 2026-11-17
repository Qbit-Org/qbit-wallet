/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');

// Shipped sources only: tests may mock or query spinners freely.
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function filesMatching(pattern) {
  return sourceFiles(path.join(extensionDir, 'src'))
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(extensionDir, file))
    .sort();
}

// Every loading state, the full-screen overlay included, shows the one Spin
// ring. Button keeps its own inline spinner in the button's text color, where
// a green ring would vanish on the green primary button.
test('loading spinners render through the Spin component', () => {
  assert.deepEqual(filesMatching(/\b(?:Lucide)?Loader\w*\b[^;]*from ['"]lucide-react['"]/), [
    'src/ui/components/Button/index.tsx'
  ]);
  assert.deepEqual(filesMatching(/\bicon-spin\b/), [
    'src/ui/components/Button/index.tsx',
    'src/ui/components/Spin/index.tsx'
  ]);
  // No hand-rolled looping animation in a component (platformFixes.ts's redraw
  // workaround is not a spinner).
  assert.deepEqual(
    filesMatching(/\banimation\b[^\n]*\binfinite\b/).filter((file) => file.endsWith('.tsx')),
    []
  );
});
