/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('Qbit recovery keys exist in every locale with matching placeholders', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
  const recoveryKeys = Object.keys(en).filter((key) => key.startsWith('qbit_recovery_'));
  assert.ok(
    recoveryKeys.includes('qbit_recovery_protected_assets_error'),
    'en must define the protected-asset migration instruction'
  );

  for (const locale of fs.readdirSync(localesDir)) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    if (!fs.existsSync(messagesPath)) continue;

    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    for (const key of recoveryKeys) {
      assert.ok(messages[key]?.message.trim(), `${locale} must translate ${key}`);
      assert.deepEqual(
        placeholders(messages[key].message),
        placeholders(en[key].message),
        `${locale} ${key} placeholders must match en`
      );
    }
  }
});
