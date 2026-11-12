/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// The send screen's notes for a send past a network size limit, with the
// placeholders each takes: what MAX leaves behind when one transaction
// carries the most it can send (#276, #170), and the unconfirmed ancestor
// size (#345). An amount past what one transaction carries is a send plan
// (#188, send-plan-locales.test.js).
const KEYS = {
  send_all_leaves_outputs_behind: ['$1', '$2', '$3', '$4'],
  send_exceeds_ancestor_size: []
};

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('send size limit keys exist in every locale with matching placeholders', () => {
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
