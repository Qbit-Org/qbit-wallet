/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// The approval of a website's PSBT that signs an input under SIGHASH_ANYONECANPAY (#211).
const KEYS = [
  'qbit_partial_signature_description',
  'qbit_partial_signature_inputs',
  'qbit_partial_signature_locked_output',
  'qbit_partial_signature_all_outputs',
];

test('partial-signature keys exist in every locale without placeholders', () => {
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

test('the English description says the signature leaves the rest open to change', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
  assert.match(en.qbit_partial_signature_description.message, /only part of this transaction/);
  assert.match(en.qbit_partial_signature_description.message, /change anything it does not cover/);
});
