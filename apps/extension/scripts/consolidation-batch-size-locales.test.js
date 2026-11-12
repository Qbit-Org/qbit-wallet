/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// The consolidation screen's batch size (#170), with the placeholders each
// key takes: the description line, the field's label, range and error, the
// fee of a full batch, and what a smaller batch adds in fees. The status
// lines, which promise no number of batches (#169), are checked in
// consolidation-locales.test.js.
const KEYS = {
  consolidation_description: [],
  consolidation_batch_size_label: [],
  consolidation_batch_size_range: ['$1', '$2'],
  consolidation_batch_size_invalid: ['$1', '$2'],
  consolidation_fee_preview: ['$1', '$2', '$3'],
  consolidation_cost_note: ['$1', '$2', '$3'],
  consolidation_cost_note_small: ['$1', '$2']
};

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('consolidation batch size keys exist in every locale with matching placeholders', () => {
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

// The fee preview prices a batch filled to the chosen size: a batch may
// carry fewer inputs, so every locale says the estimate is for a full one.
const FULL_BATCH = {
  en: /\bfull batch\b/,
  es: /\blote completo\b/,
  fr: /\blot complet\b/,
  ja: /満杯のバッチ/,
  ru: /полного пакета/,
  zh_TW: /裝滿/
};

test('the fee preview names a full batch in every locale', () => {
  for (const locale of REQUIRED_LOCALES) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    assert.match(messages.consolidation_fee_preview.message, FULL_BATCH[locale], `${locale} consolidation_fee_preview`);
  }
});

test('the cost note gives its figure as a percentage, and its small variant never a figure of 0', () => {
  for (const locale of REQUIRED_LOCALES) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    assert.match(messages.consolidation_cost_note.message, /\$2\s?%/, `${locale} consolidation_cost_note percentage`);
    assert.match(
      messages.consolidation_cost_note_small.message,
      /1\s?%/,
      `${locale} consolidation_cost_note_small bound`
    );
    assert.doesNotMatch(messages.consolidation_cost_note_small.message, /\b0\s?%/, `${locale} never 0%`);
  }
});
