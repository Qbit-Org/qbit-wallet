/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// Why a send stops before its first signature when an input it would spend
// fails the check of its funding transaction (#210): one message for each
// cause, none with a placeholder; and, for a payment sent in several
// transactions, the title and the explanation of its pause for each cause.
const CAUSES = ['mismatch', 'not_spendable', 'not_found', 'unchecked'];
// Only a check that could not read the explorer offers a remedy, "try again
// in a moment", which is true wherever it shows: a retry reads again. The
// others offer none, as none is true everywhere: Send keeps the outputs it
// read, and a retry cannot help a fee bump, a recovery or a website's
// approval with a mismatch or a missing transaction.
const NO_REMEDY = ['mismatch', 'not_spendable', 'not_found'];
// How each locale says that the wallet stopped before signing, which every
// cause's message says, and which only the remedy may follow.
const STOPPED = {
  en: 'stopped before signing',
  es: 'se detuvo antes de firmar',
  fr: 'arrêté avant de signer',
  ja: '署名の前に停止しました',
  ru: 'остановился до подписания',
  zh_TW: '在簽署前就停止了'
};
// The words each locale would say a remedy in: trying again, later, in a
// moment, reading the outputs again, reopening. None of the causes that
// offer no remedy may carry one, wherever it is put.
const REMEDY = {
  en: /try again|again later|in a moment|read the outputs|reopen/i,
  es: /intent|de nuevo|vuelve a|más tarde|en un momento|reabr/i,
  fr: /essay|relis|plus tard|instant|rouvr/i,
  ja: /もう一度|お試し|後で|しばらく|読み直/,
  ru: /повтор|прочит|позже|открой/i,
  zh_TW: /再試|重新|稍後/
};
const KEYS = [
  ...CAUSES.map((cause) => `send_input_check_${cause}`),
  ...CAUSES.flatMap((cause) => [`send_plan_paused_input_check_${cause}`, `send_plan_paused_input_check_${cause}_body`])
];

test('send input check keys exist in every locale, translated and without placeholders', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));

  for (const locale of REQUIRED_LOCALES) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    for (const key of KEYS) {
      const message = messages[key]?.message;
      assert.ok(message?.trim(), `${locale} must translate ${key}`);
      assert.doesNotMatch(message, /\$\d/, `${locale} ${key} takes no placeholder`);
      if (locale !== 'en') {
        assert.notEqual(message, en[key].message, `${locale} ${key} must not be an English placeholder`);
      }
    }
  }
});

test('the messages are true wherever a failed check shows them, and a plan’s pause speaks of the plan', () => {
  const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
  for (const cause of CAUSES) {
    // Sending, consolidating, raising a fee, recovering, a website's approval:
    // each meets these, so none speaks of a send, nor of reopening Send, and
    // none says that nothing was signed where nothing ever is (Next). Each
    // says what happened and that the wallet stopped before signing.
    const message = en[`send_input_check_${cause}`].message;
    assert.match(message, /this transaction/);
    assert.doesNotMatch(message, /this send|Reopen Send|nothing was signed/i);
    assert.match(message, /stopped before signing\./);
    if (NO_REMEDY.includes(cause)) {
      assert.match(message, /stopped before signing\.$/);
      assert.doesNotMatch(message, /try again|again later|in a moment|read the outputs|reopen/i);
    } else {
      assert.match(message, /stopped before signing\. Try again in a moment\.$/);
    }
    // A plan is continued or reviewed again, not reopened from Send, and the
    // output may be any step's, not only the next one's.
    const body = en[`send_plan_paused_input_check_${cause}_body`].message;
    assert.doesNotMatch(body, /Reopen Send|would spend next/i);
    assert.match(body, /this payment spends/);
    assert.match(body, /Continue|continue/);
  }
  // A plan paused on these may be reviewed again from the outputs as they are now.
  for (const cause of ['not_found', 'not_spendable']) {
    assert.match(en[`send_plan_paused_input_check_${cause}_body`].message, /review the payment again/i);
  }
  // Each translation says as much as the English, sentence for sentence, and
  // ends as it does: where the wallet stopped before signing, for the causes
  // that offer no remedy, so none carries one, whether in a sentence of its
  // own, after a semicolon, or after a colon before or after the stop; and
  // with that one short remedy for a check that could not be made.
  const sentences = (text) => (text.match(/。|\.(?=\s|$)/g) ?? []).length;
  const colons = (text) => (text.match(/[:：]/g) ?? []).length;
  for (const locale of REQUIRED_LOCALES) {
    const messages = JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
    for (const cause of CAUSES) {
      const key = `send_input_check_${cause}`;
      const message = messages[key].message;
      assert.equal(sentences(message), sentences(en[key].message), `${locale} ${key} says no more than the English`);
      const stopped = message.lastIndexOf(STOPPED[locale]);
      assert.ok(stopped >= 0, `${locale} ${key} says that the wallet stopped before signing`);
      const after = message.slice(stopped + STOPPED[locale].length);
      if (NO_REMEDY.includes(cause)) {
        assert.match(after, /^[.。]$/, `${locale} ${key} ends where the wallet stopped: no remedy`);
        assert.doesNotMatch(message, /[;；]/, `${locale} ${key} carries no remedy after a semicolon`);
        assert.doesNotMatch(message, REMEDY[locale], `${locale} ${key} names no remedy anywhere`);
        // A colon only where the English has one, or, in French, where the
        // English says "so" before the stop: none brings in anything more.
        assert.ok(
          colons(message) <= colons(en[key].message) + (locale === 'fr' ? 1 : 0),
          `${locale} ${key} adds nothing after a colon the English does not have`
        );
      } else {
        const remedy = after.slice(1).trim();
        assert.match(after, /^[.。]/, `${locale} ${key} ends the stop's sentence before its remedy`);
        assert.equal(sentences(remedy), 1, `${locale} ${key} offers one short remedy`);
        assert.doesNotMatch(remedy, /[;；:：]/, `${locale} ${key} offers that remedy alone`);
      }
    }
  }
  // Not spendable yet names each of its cases.
  for (const key of ['send_input_check_not_spendable', 'send_plan_paused_input_check_not_spendable_body']) {
    assert.match(en[key].message, /mining reward that has not matured/);
    assert.match(en[key].message, /unconfirmed payment from someone else/);
    assert.match(en[key].message, /too many unconfirmed transactions before it/);
  }
});
