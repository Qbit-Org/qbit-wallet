/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];

// Copy Settings → Security and the Reset Wallet dialog added.
const RESET_WALLET_KEYS = [
  'security',
  'reset_wallet',
  'reset_wallet_erases',
  'reset_wallet_keeps',
  'reset_wallet_last_wallet',
  'reset_wallet_recovery_title',
  'reset_wallet_restore_warning'
];

// Copy the flow reuses: the reset-incomplete message, the Security rows and
// the risk step it shares with the removal dialog. The background still
// refuses to remove the last wallet with its message.
const REUSED_KEYS = [
  'wallet_reset_incomplete',
  'change_password',
  'show_secret_recovery_phrase',
  'current_password',
  'password_error',
  'qbit_recovery_removal_unverified',
  'this_action_is_not_reversible',
  'enter',
  'to_proceed',
  'removing_the_last_wallet_is_not_allowed'
];

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();
const read = (locale) => JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));

test('the six locales are the ones the reset copy is written for', () => {
  const present = fs
    .readdirSync(localesDir)
    .filter((locale) => fs.existsSync(path.join(localesDir, locale, 'messages.json')))
    .sort();
  assert.deepEqual(present, [...LOCALES].sort());
});

test('every reset wallet string is translated in every locale with the English placeholders', () => {
  const en = read('en');
  for (const locale of LOCALES) {
    const messages = read(locale);
    for (const key of [...RESET_WALLET_KEYS, ...REUSED_KEYS]) {
      const message = messages[key]?.message;
      assert.ok(message?.trim(), `${locale} must translate ${key}`);
      assert.doesNotMatch(message, /\[TODO\]/, `${locale} ${key} is a placeholder`);
      assert.deepEqual(
        placeholders(message),
        placeholders(en[key].message),
        `${locale} ${key} placeholders must match en`
      );
    }
    if (locale !== 'en') {
      for (const key of RESET_WALLET_KEYS) {
        assert.notEqual(messages[key].message, en[key].message, `${locale} ${key} must not be left in English`);
      }
    }
  }
});

test('the English copy says what a reset erases and keeps', () => {
  const en = read('en');
  assert.equal(en.security.message, 'Security');
  assert.equal(en.reset_wallet.message, 'Reset Wallet');
  for (const erased of [
    'every wallet and its keys',
    'password',
    'Touch ID unlock',
    'connected sites',
    'wallet and account names and colors',
    'address book',
    'settings'
  ]) {
    assert.ok(en.reset_wallet_erases.message.includes(erased), `the erase list names ${erased}`);
  }
  assert.match(en.reset_wallet_keeps.message, /language and theme/);
  assert.match(en.reset_wallet_restore_warning.message, /only from their seed phrases or private keys/);
  assert.match(en.reset_wallet_last_wallet.message, /resets Qbit Wallet/);
});

test('every locale defines the same keys', () => {
  const enKeys = Object.keys(read('en')).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(read(locale)).sort(), enKeys, `${locale} keys must match en`);
  }
});
