/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');
const iconSource = fs.readFileSync(path.join(extensionDir, 'src/ui/components/Icon/index.tsx'), 'utf8');
const maskedIconBranch = iconSource.slice(iconSource.indexOf('if (iconPath)'));

test('explicit icon colors take precedence over style background colors', () => {
  assert.match(iconSource, /const \{ backgroundColor: styleTintColor, \.\.\.imageStyleOverride \}/);
  assert.match(iconSource, /const tintColor = color \? colors\[color\] : styleTintColor/);
  assert.match(maskedIconBranch, /\n\s+imageStyleOverride,\n/);
  assert.doesNotMatch(maskedIconBranch, /\$imageStyleOverride \|\| \{\}/);
});
