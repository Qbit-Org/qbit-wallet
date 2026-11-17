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
  'reset_wallet_last_wallet',
  'reset_wallet_recovery_title',
  'reset_wallet_restore_warning'
];

// The risk lines of the reset dialog's recovery step: the five risks of the
// removal dialog's lines, for a wallet among all those a reset erases.
const RESET_RISK_KEYS = [
  'reset_wallet_recovery_source_migrating',
  'reset_wallet_recovery_source_migrated',
  'reset_wallet_recovery_destination',
  'reset_wallet_recovery_inflight',
  'reset_wallet_recovery_unverified'
];

// Copy the flow reuses: the reset-incomplete message, the Security rows and
// the lines of the risk step that are not risks, which it shares with the
// removal dialog (its risk lines are its own, above). The background still
// refuses to remove the last wallet with its message.
const REUSED_KEYS = [
  'wallet_reset_incomplete',
  'change_password',
  'show_secret_recovery_phrase',
  'current_password',
  'password_error',
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

test('every locale says each reset risk, translated, right after the recovery title', () => {
  const en = read('en');
  for (const locale of LOCALES) {
    const messages = read(locale);
    const keys = Object.keys(messages);
    const title = keys.indexOf('reset_wallet_recovery_title');
    assert.deepEqual(keys.slice(title + 1, title + 1 + RESET_RISK_KEYS.length), RESET_RISK_KEYS, locale);
    for (const key of RESET_RISK_KEYS) {
      const message = messages[key]?.message;
      assert.ok(message?.trim(), `${locale} must translate ${key}`);
      assert.doesNotMatch(message, /\[TODO\]/, `${locale} ${key} is a placeholder`);
      assert.deepEqual(placeholders(message), placeholders(en[key].message), `${locale} ${key} placeholders`);
      if (locale !== 'en') {
        assert.notEqual(message, en[key].message, `${locale} ${key} must not be left in English`);
        assert.notEqual(
          message,
          messages[key.replace('reset_wallet_recovery_', 'qbit_recovery_removal_')].message,
          `${locale} ${key} must not be the removal's line`
        );
      }
      if (locale === 'ja' || locale === 'zh_TW') {
        assert.doesNotMatch(message, /[,.;:()]/, `${locale} ${key} must use full-width punctuation`);
      }
    }
  }
});

// A reset erases every wallet: its risk lines speak of a wallet being erased
// and of the reset, not of "this wallet" or of its removal.
test('the English reset risks speak of a reset, not of removing this wallet', () => {
  const en = read('en');
  for (const key of RESET_RISK_KEYS) {
    const message = en[key].message;
    assert.doesNotMatch(message, /this wallet|remov/i, key);
    assert.notEqual(message, en[key.replace('reset_wallet_recovery_', 'qbit_recovery_removal_')].message, key);
  }
  for (const key of RESET_RISK_KEYS.filter((key) => key !== 'reset_wallet_recovery_inflight')) {
    assert.match(en[key].message, /a (restored )?wallet you are erasing/i, key);
  }
  assert.match(en.reset_wallet_recovery_inflight.message, /After the reset/);
});

// The dialog names the main things a reset erases, not every one (it also
// erases Touch ID unlock and the wallet and account names and colors), and no
// longer says what it keeps (the language and the theme).
test('the English copy says what a reset erases', () => {
  const en = read('en');
  assert.equal(en.security.message, 'Security');
  assert.equal(en.reset_wallet.message, 'Reset Wallet');
  assert.equal(
    en.reset_wallet_erases.message,
    'This erases from this browser every wallet and its keys, your password, connected sites, address book and your settings.'
  );
  assert.match(en.reset_wallet_restore_warning.message, /only from their seed phrases or private keys/);
  assert.match(en.reset_wallet_last_wallet.message, /resets Qbit Wallet/);
});

test('no locale has the dropped "language and theme are kept" sentence', () => {
  for (const locale of LOCALES) {
    assert.equal(read(locale).reset_wallet_keeps, undefined, `${locale} reset_wallet_keeps`);
  }
});

test('the erase sentence of every locale is the shortened one, without Touch ID unlock', () => {
  for (const locale of LOCALES) {
    assert.doesNotMatch(read(locale).reset_wallet_erases.message, /Touch ID/, locale);
  }
});

test('every locale defines the same keys', () => {
  const enKeys = Object.keys(read('en')).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(read(locale)).sort(), enKeys, `${locale} keys must match en`);
  }
});
