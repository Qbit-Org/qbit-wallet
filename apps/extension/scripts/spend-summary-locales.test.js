/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// The net spend, fee warning and unrecognised-output lines of approvals and
// the send screen (#271), with the placeholders each takes.
const KEYS = {
  net_spend_leaves_wallet: [],
  net_spend_breakdown: ['$1', '$2', '$3', '$4'],
  net_spend_unknown: [],
  fee_warning_above_recommended: ['$1', '$2', '$3'],
  fee_warning_above_relay_floor: ['$1', '$2', '$3'],
  fee_warning_amount_share: ['$1', '$2', '$3'],
  fee_warning_recommendation_unavailable: [],
  unrecognised_output: [],
  unrecognised_outputs_summary: ['$1', '$2', '$3'],
  unrecognised_output_risk_title: [],
  unrecognised_output_risk_description: [],
  // Defined before #271 and shown since.
  the_fee_rate_is_much_higher_than_recommended_fee_rate: [],
  high_fee_rate_risk_title: [],
  // The same checks for a quick-signed batch (#367).
  multisign_flagged_transactions: ['$1'],
  multisign_risks_description: [],
  understand_and_accept_the_risks_of_these_transactions: [],
  multisign_account_changed: []
};

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('spend summary keys exist in every locale with matching placeholders', () => {
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
