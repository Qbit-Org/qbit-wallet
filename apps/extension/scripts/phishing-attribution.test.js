/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');
const phishingSource = fs.readFileSync(path.join(extensionDir, 'src/ui/pages/Phishing/PhishingScreen.tsx'), 'utf8');
const localesDir = path.join(extensionDir, 'src/_locales');
const genericWarningKey = 'malicious_behavior_and_suspicious_activity_have_be';

test('phishing warning uses the bundled-policy description', () => {
  assert.match(phishingSource, new RegExp(`t\\('${genericWarningKey}'\\)`));
});

test('generic phishing warning is translated in every bundled locale', () => {
  for (const locale of fs.readdirSync(localesDir)) {
    const messagesPath = path.join(localesDir, locale, 'messages.json');
    if (!fs.existsSync(messagesPath)) continue;

    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    assert.equal(typeof messages[genericWarningKey]?.message, 'string', `${locale} is missing ${genericWarningKey}`);
    assert.notEqual(messages[genericWarningKey].message.trim(), '', `${locale} has an empty ${genericWarningKey}`);
  }
});
