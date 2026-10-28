/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REGTEST_PORT = '3002';

const REGTEST_ACCESS_KEYS = [
  'disabled',
  'enable',
  'enable_local_regtest_title',
  'enabled',
  'local_regtest',
  'regtest_access_acknowledgement',
  'regtest_access_denied',
  'regtest_access_disable_note',
  'regtest_access_disabled',
  'regtest_access_enabled',
  'regtest_access_no_value',
  'regtest_access_not_enabled',
  'regtest_access_request_failed',
  'regtest_access_retry',
  'regtest_access_status_off',
  'regtest_access_status_on',
  'regtest_access_trust_note',
  'regtest_service_unavailable',
  'regtest_service_unexpected'
];

// Copy that must name the concrete capability and local port rather than a
// generic "I accept the risks" phrase.
const PORT_KEYS = [
  'regtest_access_acknowledgement',
  'regtest_access_trust_note',
  'regtest_service_unavailable'
];

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

function listLocales() {
  return fs.readdirSync(localesDir).filter((locale) => fs.existsSync(path.join(localesDir, locale, 'messages.json')));
}

test('local regtest access copy exists in every supported locale with matching placeholders', () => {
  const locales = listLocales();
  assert.ok(locales.length >= 6, 'expected the six supported locales');
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));

  for (const locale of locales) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    for (const key of REGTEST_ACCESS_KEYS) {
      assert.ok(messages[key]?.message?.trim(), `${locale} must translate ${key}`);
      assert.deepEqual(
        placeholders(messages[key].message),
        placeholders(en[key].message),
        `${locale} ${key} placeholders must match en`
      );
    }
  }
});

test('the explanation and acknowledgement name the local port in every locale', () => {
  for (const locale of listLocales()) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    for (const key of PORT_KEYS) {
      assert.ok(messages[key].message.includes(REGTEST_PORT), `${locale} ${key} must name port ${REGTEST_PORT}`);
    }
  }
});

test('the English copy carries the reviewed wording and the stable background error', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
  assert.equal(en.enable_local_regtest_title.message, 'Enable local Regtest');
  assert.equal(en.enable.message, 'Enable');
  assert.equal(en.enabled.message, 'Enabled');
  assert.equal(en.disabled.message, 'Disabled');
  assert.equal(en.cancel.message, 'Cancel');
  assert.equal(en.regtest_access_not_enabled.message, 'Regtest access has not been enabled');
  assert.equal(
    en.regtest_service_unavailable.message,
    "Qbit Wallet is unable to connect to your local Regtest instance, check that it's running on port 3002."
  );
  assert.equal(en.regtest_access_retry.message, 'Retry');
  assert.equal(en.regtest_service_unexpected.message, 'Unexpected service at the Regtest address');
  assert.equal(en.regtest_access_no_value.message, 'Regtest coins have no monetary value.');
  assert.equal(en.regtest_access_explanation, undefined, 'the feature description paragraph was removed');
  assert.equal(
    en.regtest_access_trust_note.message,
    "Enable this only if you're a developer and trust the local service running on port 3002."
  );
  assert.equal(en.regtest_access_disable_note.message, 'You can disable this access later from advanced settings.');
  assert.equal(
    en.regtest_access_acknowledgement.message,
    'I understand Qbit Wallet will be able to communicate with any local service running on port 3002.'
  );
});
