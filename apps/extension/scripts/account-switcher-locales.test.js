/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];

// Copy the account switcher added or changed.
const SWITCHER_KEYS = [
  'account_created',
  'account_switcher_account_count_few',
  'account_switcher_account_count_many',
  'account_switcher_account_count_one',
  'account_switcher_account_count_other',
  'account_switcher_account_label',
  'account_switcher_account_options_label',
  'account_switcher_add_account_label',
  'account_switcher_add_or_import_wallet',
  'account_switcher_copy_address_label',
  'account_switcher_no_results',
  'account_switcher_no_results_hint',
  'account_switcher_open_label',
  'account_switcher_search_placeholder',
  'account_switcher_wallet_options_label',
  'account_switcher_wallet_unavailable',
  'create',
  'qbit_recovery_complete_switch_wallet_hint',
  'wallet_color_blue',
  'wallet_color_gold',
  'wallet_color_green',
  'wallet_color_indigo',
  'wallet_color_orange',
  'wallet_color_pink',
  'wallet_color_teal',
  'wallet_color_violet',
  'wallet_invalid_note',
  'wallet_menu_add_account',
  'wallet_menu_backup_seed_phrase',
  'wallet_menu_change_color',
  'wallet_menu_rename',
  'wallet_tag_archived',
  'wallet_tag_read_only',
  'wallet_tag_recovered'
];

// Words that are spelled the same in English and in that language.
const SAME_AS_ENGLISH = {
  fr: ['wallet_color_indigo', 'wallet_color_orange', 'wallet_color_violet']
};

// Keys whose last caller the account switcher replaced.
const REMOVED_KEYS = ['create_an_account', 'switch_wallet'];

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();
const read = (locale) => JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));

test('the six locales are the ones the switcher copy is written for', () => {
  const present = fs
    .readdirSync(localesDir)
    .filter((locale) => fs.existsSync(path.join(localesDir, locale, 'messages.json')))
    .sort();
  assert.deepEqual(present, [...LOCALES].sort());
});

test('every account switcher string is translated in every locale with the English placeholders', () => {
  const en = read('en');
  for (const locale of LOCALES) {
    const messages = read(locale);
    for (const key of SWITCHER_KEYS) {
      assert.ok(messages[key]?.message?.trim(), `${locale} must translate ${key}`);
      assert.deepEqual(
        placeholders(messages[key].message),
        placeholders(en[key].message),
        `${locale} ${key} placeholders must match en`
      );
      if (locale !== 'en' && !(SAME_AS_ENGLISH[locale] || []).includes(key)) {
        assert.notEqual(messages[key].message, en[key].message, `${locale} ${key} must not be left in English`);
      }
    }
  }
});

test('the counts carry the number in every plural form', () => {
  for (const locale of LOCALES) {
    const messages = read(locale);
    for (const form of ['one', 'few', 'many', 'other']) {
      assert.match(messages[`account_switcher_account_count_${form}`].message, /\$1/, `${locale} ${form}`);
    }
  }
});

test('copy the switcher no longer uses is gone from every locale', () => {
  for (const locale of LOCALES) {
    const messages = read(locale);
    for (const key of REMOVED_KEYS) {
      assert.equal(messages[key], undefined, `${locale} still defines ${key}`);
    }
  }
});

test('the English copy names the switcher as the issue asks', () => {
  const en = read('en');
  assert.equal(en.switch_account.message, 'Switch Account');
  assert.equal(en.account_switcher_add_or_import_wallet.message, 'Add or import wallet');
  assert.equal(en.wallet_tag_read_only.message, 'Read Only');
  assert.equal(en.wallet_tag_recovered.message, 'Recovered');
  assert.equal(en.wallet_tag_archived.message, 'Archived');
  assert.match(en.qbit_recovery_complete_switch_wallet_hint.message, /account switcher on the home screen/);
  assert.doesNotMatch(en.qbit_recovery_complete_switch_wallet_hint.message, /top left|Switch Wallet/);
});

test('every locale defines the same keys', () => {
  const enKeys = Object.keys(read('en')).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(read(locale)).sort(), enKeys, `${locale} keys must match en`);
  }
});
