import type { ReactNode } from 'react';
import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import AddressTypeScreen from './AddressTypeScreen';
import BiometricUnlockScreen from './BiometricUnlockScreen';
import { LockTimePage } from './SecurityScreen/LockTimePage';

// The three screens that entries of Security and Advanced Settings open, each
// under a real router over the window's history: where its Back arrow leads
// when the screen is the window's first entry, and when it is not.

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return {
    Button: Container,
    Column: Container,
    Content: Container,
    Icon: Container,
    Input: () => null,
    Layout: Container,
    Loading: () => null,
    OptionListCard: Container,
    Row: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
      React.createElement('div', { onClick }, children),
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text),
    Header: ({ title, onBack }: { title?: string; onBack?: () => void }) =>
      React.createElement(
        'header',
        null,
        React.createElement('button', { onClick: onBack, 'data-testid': 'header-back-button' }, 'back'),
        title
      )
  };
});
vi.mock('@/ui/components/AddressTypeCard', () => ({ AddressTypeCard: () => null }));

vi.mock('@qbit/wallet-state', () => ({
  BiometricCeremonyCancelledError: class extends Error {},
  BiometricEnrollmentIncompleteError: class extends Error {},
  BiometricPasswordInvalidError: class extends Error {},
  BiometricPrfUnsupportedError: class extends Error {},
  useAddressTypeScreenLogic: () => ({ currentKeyring: { addressType: 0 }, items: [], onClickItem: vi.fn() }),
  useBiometricUnlock: () => ({ ready: true, supported: true, enrolled: false, enroll: vi.fn(), disable: vi.fn() }),
  useI18n: () => ({ t: (key: string) => key }),
  // A stand-in for the hook (its timing is tested in wallet-state): Back and a
  // saved choice both leave by the screen's `leave`, history Back unless given.
  useLockTimePageLogic: (options?: { leave?: () => void }) => {
    const leave = options?.leave ?? (() => window.history.back());
    return {
      autoLockTimeId: 5,
      autoLockTimes: [{ id: 3, label: 'five_minutes' }],
      loading: false,
      handleSelectOption: () => leave(),
      goBack: leave
    };
  },
  useTools: () => ({ toastError: vi.fn(), toastSuccess: vi.fn() })
}));

function Parent({ opens }: { opens: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(opens)}>open</button>;
}

function Where() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

const SECURITY = '/settings/security';
const ADVANCED = '/settings/advanced';

/** Each screen, the route it has in MainRoute, and the settings screen that lists its entry. */
const SCREENS = [
  { name: 'Touch ID Unlock', route: '/settings/biometric', title: 'touch_id_unlock', parent: SECURITY },
  { name: 'Automatic Lock Time', route: '/settings/lock-time', title: 'automatic_lock_time', parent: SECURITY },
  { name: 'Address Type', route: '/settings/address-type', title: 'address_type', parent: ADVANCED }
] as const;

function renderAt(route: string, opens: string) {
  // No router state yet, as in a window that loads this route first.
  window.history.replaceState(null, '', `#${route}`);
  return render(
    <HashRouter>
      <Where />
      <Routes>
        <Route path="/settings" element={<span>settings</span>} />
        <Route path={SECURITY} element={<Parent opens={opens} />} />
        <Route path={ADVANCED} element={<Parent opens={opens} />} />
        <Route path="/settings/biometric" element={<BiometricUnlockScreen />} />
        <Route path="/settings/lock-time" element={<LockTimePage />} />
        <Route path="/settings/address-type" element={<AddressTypeScreen />} />
      </Routes>
    </HashRouter>
  );
}

const path = () => screen.getByTestId('path').textContent;
const historyIndex = () => (window.history.state as { idx?: number } | null)?.idx;

async function historyBack() {
  await act(async () => {
    const stepped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    window.history.back();
    await stepped;
  });
}

describe('Back from the screens Security and Advanced Settings open', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '#/');
  });

  it.each(SCREENS)(
    '$name, opened with nothing behind it, goes back to $parent, and from there to Settings',
    async ({ route, title, parent }) => {
      renderAt(route, route);
      expect(screen.getByText(title)).toBeTruthy();
      expect(historyIndex()).toBe(0);

      fireEvent.click(screen.getByTestId('header-back-button'));

      await waitFor(() => expect(path()).toBe(parent));
      expect(historyIndex()).toBe(1);

      // What the parent's own Back does: one step back in history.
      await historyBack();
      await waitFor(() => expect(path()).toBe('/settings'));
      expect(historyIndex()).toBe(0);
    }
  );

  it.each(SCREENS)('$name, opened from $parent, goes one step back in history', async ({ route, title, parent }) => {
    renderAt(parent, route);
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(path()).toBe(route));
    expect(screen.getByText(title)).toBeTruthy();
    expect(historyIndex()).toBe(1);

    fireEvent.click(screen.getByTestId('header-back-button'));

    // The entry it came from, with nothing rebuilt or pushed.
    await waitFor(() => expect(path()).toBe(parent));
    expect(historyIndex()).toBe(0);
  });

  // History Back, not a route: a screen reached from anywhere returns there.
  it.each(SCREENS)('$name, opened from another screen, goes back to that screen', async ({ route }) => {
    // The other settings screen, which does not list this entry.
    const other = route === '/settings/address-type' ? SECURITY : ADVANCED;
    renderAt(other, route);
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(path()).toBe(route));

    fireEvent.click(screen.getByTestId('header-back-button'));

    await waitFor(() => expect(path()).toBe(other));
    expect(historyIndex()).toBe(0);
  });

  describe('Automatic Lock Time, once a time is chosen', () => {
    const LOCK_TIME = '/settings/lock-time';

    it('opened with nothing behind it, lands on Security, and from there goes back to Settings', async () => {
      renderAt(LOCK_TIME, LOCK_TIME);
      expect(historyIndex()).toBe(0);

      fireEvent.click(screen.getByText('five_minutes'));

      await waitFor(() => expect(path()).toBe(SECURITY));
      expect(historyIndex()).toBe(1);
      await historyBack();
      await waitFor(() => expect(path()).toBe('/settings'));
    });

    it('opened from Security, goes one step back in history', async () => {
      renderAt(SECURITY, LOCK_TIME);
      fireEvent.click(screen.getByText('open'));
      await waitFor(() => expect(path()).toBe(LOCK_TIME));
      expect(historyIndex()).toBe(1);

      fireEvent.click(screen.getByText('five_minutes'));

      await waitFor(() => expect(path()).toBe(SECURITY));
      expect(historyIndex()).toBe(0);
    });
  });
});
