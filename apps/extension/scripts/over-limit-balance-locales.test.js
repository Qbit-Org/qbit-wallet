/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// The balance card and send screen lines for an account over the explorer's
// UTXO limit (#277, #341).
const KEYS = ['utxo_limit_exceeded_balance', 'utxo_limit_exceeded_balance_detail', 'utxo_limit_exceeded_send'];

test('over-limit balance keys exist in every locale without placeholders', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));

  for (const locale of REQUIRED_LOCALES) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    for (const key of KEYS) {
      assert.ok(messages[key]?.message.trim(), `${locale} must translate ${key}`);
      assert.doesNotMatch(messages[key].message, /\$\d+/, `${locale} ${key} placeholders`);
      if (locale !== 'en') {
        assert.notEqual(messages[key].message, en[key].message, `${locale} ${key} must not be an English placeholder`);
      }
    }
  }
});
