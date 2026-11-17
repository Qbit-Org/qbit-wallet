import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { act, cleanup, render } from '@testing-library/react';
import { BUS_METHODS } from '@qbit/wallet-shared';

import { removalLeftSendPlans, SendPlansNotEndedNotice } from './index';

// The page's warning that a wallet removal could not cancel a payment in
// progress from the removed wallet (#216): the background's announcement as
// the port delivers it to every open page, the page's tools and its
// translations, each locale's text read from the extension's own messages.

const KEY = 'send_plan_removed_wallet_not_cancelled';
const LOCALES = ['en', 'es', 'fr', 'ja', 'ru', 'zh_TW'] as const;

const harness = vi.hoisted(() => {
  type Listener = (params?: unknown) => void;
  const listeners = new Map<string, Listener[]>();
  return {
    toastWarning: undefined as unknown as Mock,
    t: (key: string) => key,
    // The page's event bus: a listener that throws stops the broadcast, as
    // the extension's bus does.
    bus: {
      emit: (type: string, params?: unknown) => {
        for (const listener of listeners.get(type) ?? []) listener(params);
      },
      addEventListener: (type: string, listener: Listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      removeEventListener: (type: string, listener: Listener) => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((each) => each !== listener)
        );
      },
      count: (type: string) => (listeners.get(type) ?? []).length
    }
  };
});

vi.mock('@qbit/wallet-state', () => {
  const tools = {
    toastWarning: (content: string, options?: unknown) => harness.toastWarning(content, options)
  };
  return {
    uiEventBus: harness.bus,
    useTools: () => tools,
    useI18n: () => ({ t: harness.t, locale: 'en' })
  };
});

const here = dirname(fileURLToPath(import.meta.url));

/** The messages of `locale`, as the extension ships them. */
function messagesOf(locale: string): Record<string, { message: string }> {
  return JSON.parse(readFileSync(resolve(here, `../../../_locales/${locale}/messages.json`), 'utf8'));
}

/** The warning's text in `locale`. */
function warningIn(locale: string): string {
  return messagesOf(locale)[KEY]?.message ?? '';
}

/** The background's announcement, as JSON crosses the port. */
function announce(params: unknown): void {
  const delivered = params === undefined ? undefined : JSON.parse(JSON.stringify(params));
  act(() => harness.bus.emit(BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED, delivered));
}

beforeEach(() => {
  harness.toastWarning = vi.fn();
  harness.t = (key: string) => messagesOf('en')[key]?.message ?? key;
});

afterEach(() => {
  cleanup();
});

describe('the warning that a removal could not cancel a payment in progress', () => {
  it('says, in English, exactly what the user needs to know', () => {
    expect(warningIn('en')).toBe(
      'The wallet was removed, but a payment in progress from it could not be cancelled yet. Nothing more of it will be signed or sent, and the wallet keeps trying to cancel it.'
    );
  });

  it.each(LOCALES)('is shown once for a removal that left a plan, in the text of %s', (locale) => {
    const messages = messagesOf(locale);
    harness.t = (key: string) => messages[key]?.message ?? key;
    render(<SendPlansNotEndedNotice />);

    announce({ plans: 1, unreadable: 0, storeUnavailable: false });

    expect(harness.toastWarning).toHaveBeenCalledTimes(1);
    // A lasting warning: see shown.test.tsx for how the page's toasts show it.
    expect(harness.toastWarning).toHaveBeenCalledWith(warningIn(locale), { lasting: true });
    expect(warningIn(locale).length).toBeGreaterThan(0);
    if (locale !== 'en') expect(warningIn(locale)).not.toBe(warningIn('en'));
  });

  it.each([
    ['only an entry the store cannot read', { plans: 0, unreadable: 1, storeUnavailable: false }],
    ['a store that could not be read', { plans: 0, unreadable: 0, storeUnavailable: true }]
  ])('is shown for a removal that left %s', (_label, params) => {
    render(<SendPlansNotEndedNotice />);
    announce(params);
    expect(harness.toastWarning).toHaveBeenCalledTimes(1);
  });

  it('is not shown for a removal that left nothing', () => {
    render(<SendPlansNotEndedNotice />);
    announce({ plans: 0, unreadable: 0, storeUnavailable: false });
    expect(harness.toastWarning).not.toHaveBeenCalled();
  });

  it('is shown once for each removal announced, and not again as the page renders', () => {
    const { rerender } = render(<SendPlansNotEndedNotice />);
    announce({ plans: 2, unreadable: 0, storeUnavailable: false });
    rerender(<SendPlansNotEndedNotice />);
    rerender(<SendPlansNotEndedNotice />);
    expect(harness.toastWarning).toHaveBeenCalledTimes(1);
    announce({ plans: 1, unreadable: 0, storeUnavailable: false });
    expect(harness.toastWarning).toHaveBeenCalledTimes(2);
    expect(harness.bus.count(BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED)).toBe(1);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'plans'],
    ['a list', [1, 0, false]],
    ['a count as a string', { plans: '1', unreadable: 0, storeUnavailable: false }],
    ['a count below none', { plans: -1, unreadable: 0, storeUnavailable: false }],
    ['a count that is not whole', { plans: 1.5, unreadable: 0, storeUnavailable: false }],
    ['a count the port turned to null', { plans: Number.NaN, unreadable: 0, storeUnavailable: false }],
    ['an infinite count', { plans: Number.POSITIVE_INFINITY, unreadable: 0, storeUnavailable: false }],
    ['the flag as a string', { plans: 1, unreadable: 0, storeUnavailable: 'true' }],
    ['a count left out', { plans: 1, storeUnavailable: false }],
    ['the flag left out', { plans: 1, unreadable: 0 }]
  ])('ignores %s, without an error', (_label, params) => {
    render(<SendPlansNotEndedNotice />);
    expect(() => announce(params)).not.toThrow();
    expect(harness.toastWarning).not.toHaveBeenCalled();
  });

  it('stops listening once the page is gone', () => {
    const { unmount } = render(<SendPlansNotEndedNotice />);
    unmount();
    expect(harness.bus.count(BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED)).toBe(0);
    announce({ plans: 1, unreadable: 0, storeUnavailable: false });
    expect(harness.toastWarning).not.toHaveBeenCalled();
  });
});

describe('removalLeftSendPlans', () => {
  it('reads two counts and a flag with something left, and nothing else', () => {
    expect(removalLeftSendPlans({ plans: 1, unreadable: 0, storeUnavailable: false })).toBe(true);
    expect(removalLeftSendPlans({ plans: 0, unreadable: 0, storeUnavailable: false })).toBe(false);
    expect(removalLeftSendPlans({ plans: 1, unreadable: 0, storeUnavailable: false, extra: 'x' })).toBe(true);
    expect(removalLeftSendPlans({ plans: null, unreadable: 0, storeUnavailable: false })).toBe(false);
  });
});
