/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// The consolidation screen's status lines and the texts that name the
// explorer's refusal elsewhere, with the placeholders each takes (#169): the
// explorer's answer, never a count of batches or a promise that consolidating
// ends it, since electrs keeps refusing an address that once passed its limit.
const KEYS = {
  consolidation_status: ['$1', '$2'],
  consolidation_status_no_limit: ['$1'],
  consolidation_refusal_lasts: [],
  consolidation_within_limit: [],
  consolidation_error_within_limit: [],
  consolidation_send_note: [],
  utxo_limit_exceeded_send: [],
  utxo_limit_exceeded_balance: [],
  qbit_recovery_deferred_history_too_large: ['$1'],
  qbit_recovery_deferred_history_incomplete: []
};

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('consolidation status keys exist in every locale with matching placeholders', () => {
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
    // The batch counts it used to promise are gone with their keys.
    assert.equal(messages.consolidation_status_confirming, undefined, `${locale} consolidation_status_confirming`);
    assert.equal(messages.consolidation_status_counts, undefined, `${locale} consolidation_status_counts`);
  }
});
