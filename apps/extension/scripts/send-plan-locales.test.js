/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const localesDir = path.resolve(__dirname, '../src/_locales');
const REQUIRED_LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'];
// What the wallet shows for a payment that needs more transactions than one
// (#188): the send screen's card and refusals, the review, the progress
// screen with each pause, and the home screen's card, with the placeholders
// each takes.
const KEYS = {
  send_plan_notice_title: ['$1'],
  send_plan_notice_title_everything: ['$1'],
  send_plan_steps_none: [],
  send_plan_steps_one: [],
  send_plan_steps_many: ['$1'],
  send_plan_receives: [],
  send_plan_total_fee: [],
  send_plan_signing_label: [],
  send_plan_signatures: ['$1'],
  send_plan_time_minutes: ['$1'],
  send_plan_time_under_a_minute: [],
  send_plan_left_behind: ['$1', '$2'],
  send_plan_unconfirmed_not_included: ['$1', '$2'],
  send_plan_short_of_fees: [],
  send_plan_exceeds_plan_size: [],
  send_plan_exceeds_maximum_fee: [],
  send_plan_nothing_to_send: [],
  send_plan_max_sendable: ['$1', '$2'],
  send_plan_use_max_sendable: ['$1', '$2'],
  send_plan_unconfirmed_note: ['$1', '$2'],
  send_plan_already_open: [],
  send_plan_open_holds_rest: [],
  send_plan_view_open: [],
  send_plan_outputs_unavailable: [],
  send_plan_outputs_changed: [],
  send_plan_review_expired: [],
  send_plan_review_unavailable: [],
  send_plan_review_title: [],
  send_plan_review_transactions: [],
  send_plan_review_change: [],
  send_plan_review_budget: ['$1', '$2'],
  send_plan_review_note: [],
  send_plan_revision_title: [],
  send_plan_revision_unchanged: [],
  send_plan_revision_recipient_unchanged: [],
  send_plan_revision_amount: ['$1', '$2', '$3', '$4'],
  send_plan_revision_paid: ['$1', '$2'],
  send_plan_revision_total_fee: ['$1', '$2', '$3', '$4'],
  send_plan_revision_same_title: [],
  send_plan_revision_same: [],
  send_plan_header: [],
  send_plan_to: ['$1'],
  send_plan_fee_summary: ['$1', '$2', '$3'],
  send_plan_stage_signing: [],
  send_plan_stage_combining: [],
  send_plan_stage_paying: [],
  send_plan_stage_done: [],
  send_plan_signatures_progress: ['$1', '$2'],
  send_plan_combine_progress: ['$1', '$2'],
  send_plan_signing_close_note: [],
  send_plan_waiting_note: [],
  send_plan_slow_merge: [],
  send_plan_cancelling_title: [],
  send_plan_cancelling_body: [],
  send_plan_read_failed: [],
  send_plan_paused_locked: [],
  send_plan_paused_locked_body: [],
  send_plan_paused_interrupted: [],
  send_plan_paused_interrupted_body: [],
  send_plan_paused_merge_refused: [],
  send_plan_paused_merge_refused_body: [],
  send_plan_paused_outputs_spent: [],
  send_plan_paused_outputs_spent_body: [],
  send_plan_paused_payment_fee_too_low: [],
  send_plan_paused_payment_fee_too_low_body: [],
  send_plan_paused_payment_refused: [],
  send_plan_paused_payment_refused_body: [],
  send_plan_paused_payment_refused_unexplained: [],
  send_plan_paused_payment_refused_unexplained_body: [],
  send_plan_paused_unreadable: [],
  send_plan_paused_unreadable_body: [],
  send_plan_paused_other: [],
  send_plan_funds_untouched: [],
  send_plan_funds_partly_combined: [],
  send_plan_funds_combined: [],
  send_plan_may_confirm_title: [],
  send_plan_may_confirm_body: [],
  send_plan_may_confirm_continue: [],
  send_plan_may_confirm_raise_or_continue: [],
  send_plan_may_confirm_raise: [],
  send_plan_may_confirm_funds_held: [],
  send_plan_may_confirm_funds_partly_combined: [],
  send_plan_may_confirm_funds_combined: [],
  send_plan_action_replan: [],
  send_plan_action_raise_merge_fee: [],
  send_plan_action_raise_payment_fee: [],
  send_plan_action_cancel: [],
  send_plan_action_dismiss: [],
  send_plan_cancel_title: [],
  send_plan_cancel_body: [],
  send_plan_cancel_body_untouched: [],
  send_plan_cancel_keep: [],
  send_plan_raise_title: [],
  send_plan_raise_body: ['$1'],
  send_plan_replan_title: [],
  send_plan_replan_body: ['$1'],
  send_plan_revise_refused: [],
  send_plan_fee_rate_too_low: ['$1'],
  send_plan_home_sending: ['$1', '$2'],
  send_plan_home_paused: ['$1', '$2'],
  send_plan_home_sent: ['$1', '$2'],
  send_plan_home_cancelling: ['$1', '$2'],
  send_plan_status_signing: ['$1', '$2'],
  send_plan_status_waiting: ['$1', '$2'],
  send_plan_status_sending: [],
  send_plan_status_sent: [],
  send_plan_status_may_confirm: []
};
// Words that mean nothing to most users; the copy says "combine your funds",
// "transactions" and "payment".
const JARGON = /\b(merge[sd]?|merging|utxos?|consolidat\w*|inputs?)\b/i;

const placeholders = (message) => (message.match(/\$\d+/g) || []).sort();
const readLocale = (locale) =>
  JSON.parse(fs.readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));

test('send plan keys exist in every locale with matching placeholders', () => {
  const en = readLocale('en');

  for (const locale of REQUIRED_LOCALES) {
    const messages = readLocale(locale);
    for (const [key, expected] of Object.entries(KEYS)) {
      assert.ok(messages[key]?.message.trim(), `${locale} must translate ${key}`);
      assert.deepEqual(placeholders(messages[key].message), expected, `${locale} ${key} placeholders`);
      if (locale !== 'en') {
        assert.notEqual(messages[key].message, en[key].message, `${locale} ${key} must not be an English placeholder`);
        assert.doesNotMatch(messages[key].message, /\[TODO\]/i, `${locale} ${key} must be translated`);
      }
    }
  }
});

test('send plan copy uses plain words', () => {
  const en = readLocale('en');
  for (const key of Object.keys(KEYS)) {
    assert.doesNotMatch(en[key].message, JARGON, `en ${key}`);
  }
});

test('every paused state says first that nothing reached the recipient', () => {
  const funds = ['send_plan_funds_untouched', 'send_plan_funds_partly_combined', 'send_plan_funds_combined'];
  const firstSentence = (message) => message.slice(0, message.search(/[.。]/) + 1);
  for (const locale of REQUIRED_LOCALES) {
    const messages = readLocale(locale);
    const openings = funds.map((key) => firstSentence(messages[key].message));
    assert.ok(openings[0].length > 1, `${locale} ${funds[0]} opens with a sentence`);
    assert.deepEqual(openings, [openings[0], openings[0], openings[0]], `${locale} funds openings`);
  }
});

// What the screens say while a version of the payment that left the wallet
// without an answer may still go through (`paymentMayConfirm`).
const MAY_CONFIRM_KEYS = Object.keys(KEYS).filter((key) => key.includes('may_confirm'));

test('a payment that may still go through is never said to be unsent, nor offered a cancel or a review', () => {
  const en = readLocale('en');
  assert.equal(MAY_CONFIRM_KEYS.length, 9);
  for (const key of MAY_CONFIRM_KEYS) {
    assert.doesNotMatch(en[key].message, /\b(nothing|not sent|cancel\w*|review\w*)\b/i, `en ${key}`);
  }
  const firstSentence = (message) => message.slice(0, message.search(/[.。]/) + 1);
  for (const locale of REQUIRED_LOCALES) {
    const messages = readLocale(locale);
    // The paused states' "nothing reached the recipient" opening, in this locale.
    const nothingSent = firstSentence(messages.send_plan_funds_untouched.message);
    for (const key of MAY_CONFIRM_KEYS) {
      assert.ok(!messages[key].message.includes(nothingSent), `${locale} ${key}`);
    }
  }
});

test('the size refusal of one transaction is gone from every locale', () => {
  for (const locale of REQUIRED_LOCALES) {
    assert.equal(readLocale(locale).send_exceeds_standard_size, undefined, locale);
  }
});
