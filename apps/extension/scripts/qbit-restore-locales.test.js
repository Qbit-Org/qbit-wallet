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

const summedFloorKeys = {
  regtest: ['qbit_restore_summed_floor_regtest_history', 'qbit_restore_summed_floor_regtest_stats'],
  testnet4: ['qbit_restore_summed_floor_testnet4_history', 'qbit_restore_summed_floor_testnet4_stats']
};
const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('Qbit restore summed-floor refusals name the account, the count, the threshold and what to do in every locale', () => {
  const locales = fs
    .readdirSync(localesDir)
    .filter((locale) => fs.existsSync(path.join(localesDir, locale, 'messages.json')));
  assert.ok(locales.length >= 6, 'expected the six supported locales');

  for (const locale of locales) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    const label = (key) => messages[key].message.toLocaleLowerCase();
    for (const [network, keys] of Object.entries(summedFloorKeys)) {
      for (const key of keys) {
        const message = messages[key]?.message;
        assert.ok(message?.trim(), `${locale} must translate ${key}`);
        assert.deepEqual(placeholders(message), ['$1', '$2', '$3'], `${locale} ${key} placeholders`);
        const lowered = message.toLocaleLowerCase();
        if (network === 'regtest') {
          // The way out is to take the local service out of the next scan.
          assert.ok(lowered.includes(label('local_regtest')), `${locale} ${key} must name Local Regtest`);
        } else {
          // The Testnet4 explorer cannot be turned off, so the funds stay
          // reachable through qbit Core.
          assert.ok(
            lowered.includes(label('qbit_core_recovery_descriptors')),
            `${locale} ${key} must name the qbit Core recovery descriptors`
          );
          assert.ok(
            lowered.includes(label('secret_recovery_phrase')),
            `${locale} ${key} must name the screen that shows them`
          );
        }
      }
    }
  }
});
