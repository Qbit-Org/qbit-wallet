/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');

// Chrome reads $name$ in a message as a named placeholder and refuses to load
// the whole extension when that message defines no such placeholder ("Variable
// $2$ used but not defined."), so a positional $2 written right before $3 breaks
// every locale. Names are case-insensitive and made of letters, digits, _ and @.
const namedPlaceholder = /\$([A-Za-z0-9_@]+)\$/g;
const positionalBeforeDollar = /\$[1-9]\$/g;

test('every locale message uses only placeholders Chrome can load', () => {
  const problems = [];
  for (const locale of fs.readdirSync(localesDir)) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    if (!fs.existsSync(messagesPath)) continue;

    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    for (const [key, { message, placeholders = {} }] of Object.entries(messages)) {
      const defined = new Set(Object.keys(placeholders).map((name) => name.toLowerCase()));
      for (const [token, name] of message.matchAll(namedPlaceholder)) {
        if (!defined.has(name.toLowerCase())) problems.push(`${locale} ${key}: ${token} is not a defined placeholder`);
      }
      for (const [token] of message.matchAll(positionalBeforeDollar)) {
        problems.push(`${locale} ${key}: ${token} puts a positional placeholder right before '$'`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
