import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PHISHING_PROTECTION_REFRESH_MS, PhishingProtectionCard } from './PhishingProtectionCard';
import { PHISHING_RETRY_TIMEOUT_MS, PHISHING_STATS_TIMEOUT_MS } from './phishingProtection';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, 'data-testid': dataTestId }: { children?: ReactNode; 'data-testid'?: string }) =>
    React.createElement('div', { 'data-testid': dataTestId }, children);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  // Calls onClick even while disabled, so the card's own guard is what a
  // second click meets.
  const Button = ({
    text,
    onClick,
    disabled,
    'data-testid': dataTestId
  }: {
    text?: string;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) =>
    React.createElement('button', { onClick, 'data-disabled': String(!!disabled), 'data-testid': dataTestId }, text);
  return { Button, Card: Container, Column: Container, Row: Container, Text };
});

vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({
    t: (key: string, substitutions?: string[]) => (substitutions ? `${key}(${substitutions.join('|')})` : key)
  })
}));

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

const networkRules = (overrides: Record<string, unknown> = {}) => ({
  status: 'installed',
  attempts: 1,
  blockedDomains: 120,
  skippedEntries: [],
  updatedAt: NOW,
  ...overrides
});

const protection = (status: string, reasons: string[] = []) => ({
  status,
  reasons,
  warningRedirect: { status: 'installed', hostAccess: true, updatedAt: NOW }
});

const PROTECTED = { stats: {}, networkRules: networkRules(), protection: protection('full') };

type Reply = { reply?: unknown; lastError?: string } | 'pending';
type Handler = (message: { type: string }) => Reply;

let handler: Handler;
let pending: ((reply: unknown) => void)[];
let sendMessage: ReturnType<typeof vi.fn>;

function stubChrome() {
  const runtime: { lastError?: { message: string }; sendMessage: typeof sendMessage } = {
    lastError: undefined,
    sendMessage: vi.fn()
  };
  sendMessage = runtime.sendMessage;
  sendMessage.mockImplementation((message: { type: string }, callback: (reply?: unknown) => void) => {
    const result = handler(message);
    if (result === 'pending') {
      pending.push((reply) => callback(reply));
      return;
    }
    runtime.lastError = result.lastError ? { message: result.lastError } : undefined;
    callback(result.reply);
    runtime.lastError = undefined;
  });
  vi.stubGlobal('chrome', { runtime });
}

const statsReply =
  (reply: unknown): Handler =>
  (message) =>
    message.type === 'GET_PHISHING_STATS' ? { reply } : { reply: { success: true } };

const flush = () => act(async () => undefined);
const state = () => screen.getByTestId('phishing-protection-state').textContent;
const reasons = () => screen.queryAllByTestId('phishing-protection-reason').map((node) => node.textContent);
const sent = (type: string) => sendMessage.mock.calls.filter(([message]) => message.type === type).length;

async function renderCard() {
  const view = render(<PhishingProtectionCard />);
  await flush();
  return view;
}

describe('PhishingProtectionCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    pending = [];
    handler = statsReply(PROTECTED);
    stubChrome();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows protected, with no Retry, only for an installed rule with full protection', async () => {
    await renderCard();

    expect(state()).toBe('phishing_protection_status_protected');
    expect(screen.getByText('phishing_protection_blocked_domains(120)')).toBeTruthy();
    expect(screen.queryByTestId('phishing-protection-retry')).toBeNull();
    expect(reasons()).toEqual([]);
    expect(screen.getByText('phishing_protection_list_note')).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'GET_PHISHING_STATS' }, expect.any(Function));
  });

  it.each([
    ['the read fails', { lastError: 'Could not establish connection. Receiving end does not exist.' }],
    ['the background answers an error', { reply: { error: 'Internal error processing request' } }],
    ['there is no answer', { reply: undefined }],
    ['networkRules is missing', { reply: { stats: {}, protection: protection('full') } }],
    [
      'the status is not one the background reports',
      { reply: { ...PROTECTED, networkRules: networkRules({ status: 'ok' }) } }
    ],
    ['attempts is not a count', { reply: { ...PROTECTED, networkRules: networkRules({ attempts: -1 }) } }],
    [
      'blockedDomains is missing',
      { reply: { ...PROTECTED, networkRules: networkRules({ blockedDomains: undefined }) } }
    ],
    ['updatedAt is not a time', { reply: { ...PROTECTED, networkRules: networkRules({ updatedAt: 'now' }) } }],
    ['protection is malformed', { reply: { ...PROTECTED, protection: { status: 'full' } } }],
    ['a reason is unknown', { reply: { ...PROTECTED, protection: protection('degraded', ['gremlins']) } }],
    ['the warning redirect health is missing', { reply: { ...PROTECTED, protection: { status: 'full', reasons: [] } } }]
  ])('shows status unknown, never protected, when %s', async (_, reply) => {
    handler = (message) => (message.type === 'GET_PHISHING_STATS' ? (reply as Reply) : { reply: { success: true } });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_unknown');
    expect(screen.getByTestId('phishing-protection-retry')).toBeTruthy();
  });

  it('shows status unknown for an installed rule without the protection report', async () => {
    handler = statsReply({ stats: {}, networkRules: networkRules() });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_unknown');
  });

  it('shows status unknown with its reasons when protection is unknown', async () => {
    handler = statsReply({ ...PROTECTED, protection: protection('unknown', ['redirect-rule-unknown']) });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_unknown');
    expect(reasons()).toEqual(['phishing_protection_reason_redirect_rule_unknown']);
  });

  it('shows status unknown, with the error, when the block rule cannot be read back', async () => {
    handler = statsReply({
      ...PROTECTED,
      networkRules: networkRules({ status: 'unknown', blockedDomains: null, error: 'getDynamicRules failed' }),
      protection: protection('unknown', ['block-rule-unknown'])
    });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_unknown');
    expect(screen.getByText('phishing_protection_last_error(getDynamicRules failed)')).toBeTruthy();
    expect(screen.getByText('phishing_protection_blocked_domains_unknown')).toBeTruthy();
    expect(reasons()).toEqual(['phishing_protection_reason_block_rule_unknown']);
  });

  it('shows starting while the first install is in progress', async () => {
    handler = statsReply({
      ...PROTECTED,
      networkRules: networkRules({ status: 'installing', blockedDomains: null }),
      protection: protection('degraded', ['block-rule-not-installed'])
    });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_starting');
    expect(screen.getByText('phishing_protection_blocked_domains_unknown')).toBeTruthy();
    expect(screen.queryByText('phishing_protection_blocked_domains(0)')).toBeNull();
    expect(screen.getByTestId('phishing-protection-retry')).toBeTruthy();
  });

  it('shows retrying with the attempts, the error and when the next attempt is due', async () => {
    handler = statsReply({
      ...PROTECTED,
      networkRules: networkRules({
        status: 'retrying',
        attempts: 3,
        blockedDomains: 0,
        error: 'quota exceeded',
        nextRetryAt: NOW + 14_200
      }),
      protection: protection('degraded', ['block-rule-not-installed', 'site-access-withheld'])
    });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_retrying');
    expect(screen.getByText('phishing_protection_next_attempt_in(3|15)')).toBeTruthy();
    expect(screen.getByText('phishing_protection_last_error(quota exceeded)')).toBeTruthy();
    // A read zero is a real zero.
    expect(screen.getByText('phishing_protection_blocked_domains(0)')).toBeTruthy();
    expect(reasons()).toEqual([
      'phishing_protection_reason_block_rule_not_installed',
      'phishing_protection_reason_site_access_withheld'
    ]);

    await act(async () => vi.advanceTimersByTime(4_000));
    expect(screen.getByText('phishing_protection_next_attempt_in(3|11)')).toBeTruthy();

    await act(async () => vi.advanceTimersByTime(11_000));
    expect(screen.getByText('phishing_protection_next_attempt_due(3)')).toBeTruthy();
    expect(screen.queryByText(/next_attempt_in\(3\|-/)).toBeNull();
  });

  it('shows failed with the last error', async () => {
    handler = statsReply({
      ...PROTECTED,
      networkRules: networkRules({ status: 'failed', attempts: 10, blockedDomains: 0, error: 'rule limit' }),
      protection: protection('degraded', ['block-rule-not-installed'])
    });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_failed');
    expect(screen.getByText('phishing_protection_last_error(rule limit)')).toBeTruthy();
    expect(screen.getByTestId('phishing-protection-retry')).toBeTruthy();
  });

  it('shows not supported, with no Retry, where the browser has no network rules', async () => {
    handler = statsReply({ stats: {}, networkRules: networkRules({ status: 'unsupported', blockedDomains: null }) });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_unsupported');
    expect(screen.queryByTestId('phishing-protection-retry')).toBeNull();
  });

  it('shows degraded with the reasons when the rule is installed but protection is not full', async () => {
    handler = statsReply({
      ...PROTECTED,
      protection: protection('degraded', ['redirect-rule-without-host-access'])
    });
    await renderCard();

    expect(state()).toBe('phishing_protection_status_degraded');
    expect(reasons()).toEqual(['phishing_protection_reason_redirect_rule_without_host_access']);
    expect(screen.getByTestId('phishing-protection-retry')).toBeTruthy();
  });

  it('reads the state again on an interval while shown', async () => {
    handler = statsReply({ ...PROTECTED, networkRules: networkRules({ status: 'installing' }) });
    await renderCard();
    expect(state()).toBe('phishing_protection_status_starting');

    handler = statsReply(PROTECTED);
    await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS));
    expect(state()).toBe('phishing_protection_status_protected');
    expect(sent('GET_PHISHING_STATS')).toBe(2);
  });

  it('turns a protected row unknown when a later read fails', async () => {
    await renderCard();
    expect(state()).toBe('phishing_protection_status_protected');

    handler = () => ({ lastError: 'Extension context invalidated.' });
    await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS));
    expect(state()).toBe('phishing_protection_status_unknown');
  });

  it('shows status unknown when the stats read does not answer in time', async () => {
    await renderCard();
    handler = () => 'pending';
    await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS));
    expect(state()).toBe('phishing_protection_status_protected');

    await act(async () => vi.advanceTimersByTime(PHISHING_STATS_TIMEOUT_MS));
    expect(state()).toBe('phishing_protection_status_unknown');
  });

  it('lets a read slower than the interval land instead of starting more', async () => {
    handler = () => 'pending';
    await renderCard();
    await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS + 1_000));
    expect(pending).toHaveLength(1);

    await act(async () => pending[0](PROTECTED));
    expect(state()).toBe('phishing_protection_status_protected');
  });

  it('keeps a newer read when an earlier one answers last', async () => {
    handler = statsReply({ ...PROTECTED, protection: protection('degraded', ['redirect-rule-without-host-access']) });
    await renderCard();
    handler = (message) => (message.type === 'GET_PHISHING_STATS' ? 'pending' : { reply: { success: true } });
    await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS));
    fireEvent.click(screen.getByTestId('phishing-protection-retry'));
    await flush();
    expect(pending).toHaveLength(2);

    const [poll, afterRetry] = pending;
    await act(async () => afterRetry(PROTECTED));
    await act(async () => poll({ error: 'Internal error processing request' }));
    expect(state()).toBe('phishing_protection_status_protected');
  });

  describe('Retry now', () => {
    const FAILED = {
      ...PROTECTED,
      networkRules: networkRules({ status: 'failed', attempts: 10, blockedDomains: 0, error: 'rule limit' }),
      protection: protection('degraded', ['block-rule-not-installed'])
    };

    it('reinstalls the rule, then shows the new state', async () => {
      handler = statsReply(FAILED);
      await renderCard();

      handler = statsReply(PROTECTED);
      fireEvent.click(screen.getByTestId('phishing-protection-retry'));
      await flush();

      expect(sendMessage).toHaveBeenCalledWith({ type: 'FORCE_UPDATE_PHISHING_LIST' }, expect.any(Function));
      expect(state()).toBe('phishing_protection_status_protected');
      expect(screen.queryByTestId('phishing-protection-retry')).toBeNull();
      expect(screen.queryByTestId('phishing-protection-retry-error')).toBeNull();
    });

    it('is disabled while in flight and sends one message for a second click', async () => {
      handler = (message) => (message.type === 'GET_PHISHING_STATS' ? { reply: FAILED } : 'pending');
      await renderCard();

      fireEvent.click(screen.getByTestId('phishing-protection-retry'));
      await flush();
      expect(screen.getByTestId('phishing-protection-retry').getAttribute('data-disabled')).toBe('true');
      fireEvent.click(screen.getByTestId('phishing-protection-retry'));
      await flush();

      expect(sent('FORCE_UPDATE_PHISHING_LIST')).toBe(1);

      await act(async () => pending[0]({ success: true }));
      expect(screen.getByTestId('phishing-protection-retry').getAttribute('data-disabled')).toBe('false');
    });

    it.each([
      [
        'the background reports an error',
        { reply: { error: 'Error: rule limit' } },
        'phishing_protection_retry_failed_with(rule limit)'
      ],
      [
        'the message fails',
        { lastError: 'The message port closed before a response was received.' },
        'phishing_protection_retry_failed_with(The message port closed before a response was received.)'
      ],
      ['there is no answer', { reply: undefined }, 'phishing_protection_retry_failed'],
      ['the answer is not a success', { reply: { success: false } }, 'phishing_protection_retry_failed']
    ])('shows the error, not success, and enables Retry again when %s', async (_, retryReply, text) => {
      handler = (message) => (message.type === 'GET_PHISHING_STATS' ? { reply: FAILED } : (retryReply as Reply));
      await renderCard();

      fireEvent.click(screen.getByTestId('phishing-protection-retry'));
      await flush();

      expect(screen.getByTestId('phishing-protection-retry-error').textContent).toBe(text);
      expect(state()).toBe('phishing_protection_status_failed');
      expect(sent('GET_PHISHING_STATS')).toBe(2);
      expect(screen.getByTestId('phishing-protection-retry').getAttribute('data-disabled')).toBe('false');

      // The next attempt clears the earlier error.
      handler = statsReply(FAILED);
      fireEvent.click(screen.getByTestId('phishing-protection-retry'));
      await flush();
      expect(screen.queryByTestId('phishing-protection-retry-error')).toBeNull();
    });

    it('says the outcome is not known, and enables Retry again, when the background does not answer in time', async () => {
      handler = (message) => (message.type === 'GET_PHISHING_STATS' ? { reply: FAILED } : 'pending');
      await renderCard();

      fireEvent.click(screen.getByTestId('phishing-protection-retry'));
      await act(async () => vi.advanceTimersByTime(PHISHING_RETRY_TIMEOUT_MS));

      expect(screen.getByTestId('phishing-protection-retry-error').textContent).toBe(
        'phishing_protection_retry_no_answer'
      );
      expect(screen.getByTestId('phishing-protection-retry').getAttribute('data-disabled')).toBe('false');
    });

    it('drops the failure once a later read finds a different state', async () => {
      handler = (message) =>
        message.type === 'GET_PHISHING_STATS' ? { reply: FAILED } : { reply: { error: 'Error: rule limit' } };
      await renderCard();
      fireEvent.click(screen.getByTestId('phishing-protection-retry'));
      await flush();
      expect(screen.getByTestId('phishing-protection-retry-error')).toBeTruthy();

      await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS));
      expect(screen.getByTestId('phishing-protection-retry-error')).toBeTruthy();

      handler = statsReply({ ...PROTECTED, protection: protection('degraded', ['redirect-rule-unknown']) });
      await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS));
      expect(state()).toBe('phishing_protection_status_degraded');
      expect(screen.queryByTestId('phishing-protection-retry-error')).toBeNull();
    });

    it('shows the last error without the Error: prefix', async () => {
      handler = statsReply({ ...FAILED, networkRules: networkRules({ status: 'failed', error: 'Error: quota' }) });
      await renderCard();
      expect(screen.getByText('phishing_protection_last_error(quota)')).toBeTruthy();
    });
  });

  it('stops reading and ignores late answers once unmounted', async () => {
    handler = statsReply({ ...PROTECTED, protection: protection('degraded', ['block-rule-not-installed']) });
    const view = await renderCard();
    handler = () => 'pending';
    fireEvent.click(screen.getByTestId('phishing-protection-retry'));
    await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS));
    // The Retry and the interval's read are both still unanswered.
    expect(pending).toHaveLength(2);
    const before = sendMessage.mock.calls.length;
    const errors = vi.spyOn(console, 'error');

    view.unmount();
    await act(async () => vi.advanceTimersByTime(PHISHING_PROTECTION_REFRESH_MS * 3));
    expect(sendMessage.mock.calls.length).toBe(before);

    await act(async () => pending.forEach((answer) => answer({ success: true })));
    expect(sendMessage.mock.calls.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
