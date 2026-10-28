/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const counterWarningKey = 'qbit_restore_counters_minimum_warning';

test('Qbit restore counter warnings provide explanation and recommendation paragraphs', () => {
  for (const locale of fs.readdirSync(localesDir)) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    if (!fs.existsSync(messagesPath)) continue;

    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    const paragraphs = messages[counterWarningKey]?.message.split('\n\n');

    assert.equal(paragraphs?.length, 2, `${locale} must provide exactly two ${counterWarningKey} paragraphs`);
    assert.ok(paragraphs.every((paragraph) => paragraph.trim()), `${locale} must provide two non-empty paragraphs`);
  }
});
