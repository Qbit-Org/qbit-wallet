/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');
const aboutSource = fs.readFileSync(path.join(extensionDir, 'src/ui/pages/Settings/AboutUsScreen.tsx'), 'utf8');

test('About omits terms and privacy actions while retaining the update action', () => {
  assert.doesNotMatch(aboutSource, /TERMS_OF_SERVICE_URL/);
  assert.doesNotMatch(aboutSource, /PRIVACY_POLICY_URL/);
  assert.doesNotMatch(aboutSource, /text=\{t\(['"]terms_of_service['"]\)\}/);
  assert.doesNotMatch(aboutSource, /text=\{t\(['"]privacy_policy['"]\)\}/);
  assert.match(aboutSource, /nav\.navToUrl\(UPDATE_URL\)/);
});
