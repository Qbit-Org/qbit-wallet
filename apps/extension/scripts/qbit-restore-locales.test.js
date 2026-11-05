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

const summedFloorShareKeys = [
  'qbit_restore_summed_floor_share_regtest_history',
  'qbit_restore_summed_floor_share_regtest_stats',
  'qbit_restore_summed_floor_share_testnet4_history',
  'qbit_restore_summed_floor_share_testnet4_stats'
];
// By the restored network, and whether its own share is the larger one.
const summedFloorRefusalKeys = {
  qbit_restore_summed_floor_testnet4: { turnsOffLocalRegtest: true, namesDescriptors: false },
  qbit_restore_summed_floor_testnet4_own_share_larger: { turnsOffLocalRegtest: true, namesDescriptors: true },
  qbit_restore_summed_floor_regtest: { turnsOffLocalRegtest: false, namesDescriptors: true },
  qbit_restore_summed_floor_regtest_own_share_larger: { turnsOffLocalRegtest: false, namesDescriptors: true }
};
// Each locale's instruction to turn off Local Regtest in Advanced Settings,
// worded around the two settings labels.
const turnOffLocalRegtest = {
  en: 'turn off Local Regtest in Advanced Settings',
  es: 'desactive Regtest local en Configuración Avanzada',
  fr: 'désactivez Regtest local dans les Paramètres Avancés',
  ja: '詳細設定でローカル Regtest をオフに',
  ru: 'отключите «Локальный Regtest» в разделе «Расширенные настройки»',
  zh_TW: '在進階設定中關閉本機 Regtest'
};
const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();

test('Qbit restore summed-floor refusals show both counts and say what to do in every locale', () => {
  const locales = fs
    .readdirSync(localesDir)
    .filter((locale) => fs.existsSync(path.join(localesDir, locale, 'messages.json')));
  assert.ok(locales.length >= 6, 'expected the six supported locales');

  for (const locale of locales) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    const label = (key) => {
      const message = messages[key]?.message;
      assert.ok(message?.trim(), `${locale} must translate ${key}`);
      return message;
    };

    for (const key of summedFloorShareKeys) {
      assert.deepEqual(placeholders(label(key)), ['$1'], `${locale} ${key} placeholders`);
    }

    const instruction = turnOffLocalRegtest[locale];
    assert.ok(instruction, `${locale} must have a Local Regtest instruction to check`);
    assert.ok(instruction.includes(label('local_regtest')), `${locale} instruction must name Local Regtest`);
    assert.ok(instruction.includes(label('advanced_settings')), `${locale} instruction must name Advanced Settings`);

    for (const [key, { turnsOffLocalRegtest, namesDescriptors }] of Object.entries(summedFloorRefusalKeys)) {
      const message = label(key);
      assert.deepEqual(placeholders(message), ['$1', '$2', '$3', '$4'], `${locale} ${key} placeholders`);
      // Turning off Local Regtest on a Regtest restore would leave Regtest.
      assert.equal(
        message.includes(instruction),
        turnsOffLocalRegtest,
        `${locale} ${key} ${turnsOffLocalRegtest ? 'must' : 'must not'} say to turn off Local Regtest`
      );
      if (namesDescriptors) {
        // The Testnet4 explorer cannot be turned off, so the funds stay
        // reachable through qbit Core.
        const lowered = message.toLocaleLowerCase();
        for (const name of ['qbit_core_recovery_descriptors', 'secret_recovery_phrase']) {
          assert.ok(lowered.includes(label(name).toLocaleLowerCase()), `${locale} ${key} must name ${name}`);
        }
      }
    }
  }
});
