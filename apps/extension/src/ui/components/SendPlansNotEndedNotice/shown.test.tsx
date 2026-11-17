import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useContext } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BUS_METHODS } from '@qbit/wallet-shared';
import { ToolsContext, type ToolsContextType } from '@qbit/wallet-state';

import { ToolsProvider } from '../../providers/ToolsProvider';
import { SendPlansNotEndedNotice } from './index';

// The warning that a wallet removal could not cancel a payment in progress
// (#216), as the user sees it: the page's own toasts show it, long enough
// to read, with a control that closes it, announced to assistive technology.
// No other toast changes. Only the page's state package is stood in for:
// the tools context, the translations and the event bus.

const KEY = 'send_plan_removed_wallet_not_cancelled';
const SHOWN_MS = 15_000;

const harness = vi.hoisted(() => {
  type Listener = (params?: unknown) => void;
  const listeners = new Map<string, Listener[]>();
  return {
    t: (key: string) => key,
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
      }
    }
  };
});

vi.mock('@qbit/wallet-state', async () => {
  const React = await import('react');
  const ToolsContext = React.createContext(null);
  return {
    ToolsContext,
    useTools: () => React.useContext(ToolsContext),
    useI18n: () => ({ t: (key: string) => harness.t(key), locale: 'en' }),
    uiEventBus: harness.bus
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const english = JSON.parse(readFileSync(resolve(here, '../../../_locales/en/messages.json'), 'utf8')) as Record<
  string,
  { message: string }
>;

let tools: ToolsContextType;

function CaptureTools() {
  tools = useContext(ToolsContext) as unknown as ToolsContextType;
  return null;
}

function renderPage() {
  return render(
    <ToolsProvider>
      <SendPlansNotEndedNotice />
      <CaptureTools />
    </ToolsProvider>
  );
}

/** The background's announcement of a removal that left a plan, as the port delivers it. */
function announce(): void {
  act(() =>
    harness.bus.emit(BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED, { plans: 1, unreadable: 0, storeUnavailable: false })
  );
}

function pass(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Every toast shown now. */
function toasts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.toast')];
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.t = (key: string) => english[key]?.message ?? key;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the warning that a removal could not cancel a payment in progress, as shown', () => {
  it('is announced as an alert, with a control that closes it, for 15 seconds', () => {
    renderPage();
    announce();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(english[KEY]?.message);
    expect(alert.getAttribute('aria-atomic')).toBe('true');
    expect(within(alert).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(alert.style.getPropertyValue('--toast-duration')).toBe(`${SHOWN_MS}ms`);

    pass(SHOWN_MS - 1);
    expect(screen.queryByRole('alert')).not.toBeNull();
    pass(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toasts()).toHaveLength(0);
  });

  it('goes when the user closes it, and its time running out later changes nothing', () => {
    renderPage();
    announce();
    pass(3_000);

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(toasts()).toHaveLength(0);

    pass(SHOWN_MS);
    expect(toasts()).toHaveLength(0);
  });

  it('is shown in the colours of a warning, with room for its control', () => {
    renderPage();
    announce();
    const alert = screen.getByRole('alert');
    expect(alert.style.backgroundColor).toBe('var(--qbit-warning-fill)');
    expect(alert.style.paddingRight).toBe('44px');
    expect(alert.style.position).toBe('relative');
    expect(alert.classList.contains('toast--error')).toBe(false);
  });

  it('shows each removal’s warning, and does not take the place of an error shown', () => {
    renderPage();
    act(() => tools.toastError('Invalid password'));
    announce();
    announce();
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.getAllByRole('alert').filter((each) => each.textContent === 'Invalid password')).toHaveLength(1);
  });

  it('stays when an error is shown after it, which takes the place of an earlier error alone', () => {
    renderPage();
    announce();
    act(() => tools.toastError('Invalid password'));
    act(() => tools.toastError('Invalid password'));

    const alerts = screen.getAllByRole('alert');
    expect(alerts.map((each) => each.textContent)).toEqual([english[KEY]?.message, 'Invalid password']);
  });

  it('leaves every other warning as it was: two seconds, no control, no alert', () => {
    renderPage();
    act(() => tools.toastWarning('A plain warning'));

    const [toast] = toasts();
    expect(toast?.textContent).toBe('A plain warning');
    expect(toast?.getAttribute('role')).toBeNull();
    expect(toast?.querySelector('button')).toBeNull();
    expect(toast?.style.getPropertyValue('--toast-duration')).toBe('2000ms');
    pass(1_999);
    expect(toasts()).toHaveLength(1);
    pass(1);
    expect(toasts()).toHaveLength(0);
  });

  it('leaves the error toast as it was: eight seconds, alone', () => {
    renderPage();
    act(() => tools.toastError('Invalid password'));
    const alert = screen.getByRole('alert');
    expect(alert.classList.contains('toast--error')).toBe(true);
    expect(alert.style.getPropertyValue('--toast-duration')).toBe('8000ms');
    pass(7_999);
    expect(screen.queryByRole('alert')).not.toBeNull();
    pass(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
