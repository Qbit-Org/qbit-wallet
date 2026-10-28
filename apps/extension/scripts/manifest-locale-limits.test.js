/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');

// Chrome Web Store limits for manifest fields resolved from __MSG_*__ placeholders:
// https://developer.chrome.com/docs/extensions/reference/manifest — name <= 45,
// description <= 132 characters. Every locale must comply, not just default_locale.
const manifestMessageLimits = Object.freeze({
  appName: 45,
  appDescription: 132
});

test('localized manifest name and description stay within Chrome Web Store limits', () => {
  for (const locale of fs.readdirSync(localesDir)) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    if (!fs.existsSync(messagesPath)) continue;

    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    for (const [key, limit] of Object.entries(manifestMessageLimits)) {
      const message = messages[key]?.message;
      assert.equal(typeof message, 'string', `${locale} is missing ${key}`);
      assert.notEqual(message.trim(), '', `${locale} has an empty ${key}`);

      const length = [...message].length;
      assert.ok(length <= limit, `${locale} ${key} is ${length} characters, above the ${limit}-character limit`);
    }
  }
});
