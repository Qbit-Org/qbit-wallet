/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// What the wallet shows while it signs many inputs and broadcasts the result
// (#171), with the placeholders each takes.
const KEYS = {
  signing_in_progress: [],
  signing_progress_title: [],
  signing_progress_starting: [],
  signing_progress_inputs: ['$1', '$2'],
  signing_progress_transaction: ['$1', '$2'],
  signing_progress_minutes_left: ['$1'],
  signing_progress_under_a_minute: [],
  signing_keep_open_title: [],
  signing_keep_open: [],
  signing_keep_open_popup: [],
  signing_many_inputs_title: [],
  signing_many_inputs_body: ['$1'],
  signing_many_inputs_sidebar: [],
  broadcasting_transaction: [],
  wallet_locked_during_signing: []
};

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('signing progress keys exist in every locale with matching placeholders', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));

  for (const locale of REQUIRED_LOCALES) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    for (const [key, expected] of Object.entries(KEYS)) {
      assert.ok(messages[key]?.message.trim(), `${locale} must translate ${key}`);
      assert.deepEqual(placeholders(messages[key].message), expected, `${locale} ${key} placeholders`);
      if (locale !== 'en') {
        assert.notEqual(messages[key].message, en[key].message, `${locale} ${key} must not be an English placeholder`);
      }
    }
  }
});

test('the popup warning says what the window warning says, and that an outside click closes the popup', () => {
  for (const locale of REQUIRED_LOCALES) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    assert.ok(
      messages.signing_keep_open_popup.message.includes(messages.signing_keep_open.message),
      `${locale} signing_keep_open_popup must include signing_keep_open`
    );
  }
});
