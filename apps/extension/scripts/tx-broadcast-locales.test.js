/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
const KEY_PREFIXES = ['tx_broadcast_', 'tx_not_sent_', 'tx_unknown_'];
// Every reason key the wallet can report; the failure screen renders
// `tx_broadcast_reason_<reason>` for each of them.
const FAILURE_REASONS = [
  'invalid_transaction',
  'guard_blocked',
  'chain_changed',
  'rejected',
  'network',
  'timeout',
  'server',
  'invalid_response',
  'unexpected'
];

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('broadcast recovery keys exist in every locale with matching placeholders', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
  const keys = Object.keys(en).filter((key) => KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));

  for (const reason of FAILURE_REASONS) {
    assert.ok(keys.includes(`tx_broadcast_reason_${reason}`), `en must describe the ${reason} reason`);
  }
  // An unknown verdict whose node answer was a rejection shows this instead
  // of the definitive rejected line.
  assert.ok(keys.includes('tx_broadcast_reason_rejected_unconfirmed'), 'en must describe an unconfirmed rejection');
  // An unknown verdict whose guard refusal was a reservation the wallet no
  // longer holds shows this instead of the conflict line.
  assert.ok(
    keys.includes('tx_broadcast_reason_guard_blocked_unconfirmed'),
    'en must describe a reservation the wallet no longer holds'
  );
  for (const key of [
    'tx_not_sent_title',
    'tx_unknown_title',
    'tx_unknown_warning',
    'tx_broadcast_signature_notice',
    'tx_broadcast_retry_notice',
    'tx_broadcast_retry',
    'tx_broadcast_check_status',
    'tx_broadcast_back_to_wallet'
  ]) {
    assert.ok(keys.includes(key), `en must define ${key}`);
  }

  for (const locale of REQUIRED_LOCALES) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    assert.ok(fs.existsSync(messagesPath), `${locale} locale must exist`);
    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    for (const key of keys) {
      assert.ok(messages[key]?.message.trim(), `${locale} must translate ${key}`);
      assert.deepEqual(
        placeholders(messages[key].message),
        placeholders(en[key].message),
        `${locale} ${key} placeholders must match en`
      );
      if (locale !== 'en') {
        assert.notEqual(messages[key].message, en[key].message, `${locale} ${key} must not be an English placeholder`);
      }
    }
  }
});
