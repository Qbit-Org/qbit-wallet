/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../../..');
const entrySource = fs.readFileSync(path.join(repoRoot, 'apps/extension/src/ui/index.tsx'), 'utf8');

// Every wallet page tells the user when a wallet removal could not cancel a
// payment in progress from the removed wallet (#216): the notice is mounted
// by the page's entry, where its translations and its toasts are at hand.
test('every wallet page mounts the notice of a removal that left a payment, with its translations and tools', () => {
  assert.match(entrySource, /import \{ SendPlansNotEndedNotice \} from '\.\/components\/SendPlansNotEndedNotice';/);
  assert.match(
    entrySource,
    /<I18nProvider>[\s\S]*<ToolsProvider>[\s\S]*<SendPlansNotEndedNotice \/>[\s\S]*<\/ToolsProvider>[\s\S]*<\/I18nProvider>/
  );
});
