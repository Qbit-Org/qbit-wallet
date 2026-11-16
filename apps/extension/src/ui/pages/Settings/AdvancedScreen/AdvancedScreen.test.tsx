import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import AdvancedScreen from './index';

const harness = vi.hoisted(
  () =>
    ({}) as {
      routerNavigate: Mock;
      addressType: { label: string; value: string; onClick: Mock };
      regtest: { state: string; gated: boolean } | null;
    }
);

// The screen and its entries are real; what they draw with and read are
// stand-ins.
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    onClick,
    'data-testid': testId
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { onClick, 'data-testid': testId }, children);
  return {
    // The building blocks of the lock settings and the phishing card too, so
    // that either of them put back on this screen would show up as rows in
    // the assertions below, not as a crash.
    Button: Container,
    Card: Container,
    Column: Container,
    Content: ({ children }: { children?: ReactNode }) =>
      React.createElement('main', { 'data-testid': 'screen-content' }, children),
    Header: ({ title, onBack }: { title?: string; onBack?: () => void }) =>
      React.createElement('header', null, React.createElement('button', { onClick: onBack }, 'back'), title),
    Icon: ({ icon }: { icon?: string }) => React.createElement('i', { 'data-icon': icon }),
    Layout: Container,
    Row: Container,
    Switch: () => React.createElement('button', { role: 'switch' }),
    Text: ({ text, 'data-testid': testId }: { text?: string; 'data-testid'?: string }) =>
      React.createElement('span', { 'data-testid': testId }, text)
  };
});
vi.mock('@/ui/components/LoadingPage', () => ({ default: () => 'loading' }));

vi.mock('react-router-dom', () => ({ useNavigate: () => harness.routerNavigate }));

vi.mock('@/ui/utils/regtestAccess', () => ({
  useRegtestAccessStatus: () => ({ status: harness.regtest }),
  isRegtestLocked: (status: { gated: boolean; state: string } | null) =>
    !status || (status.gated && status.state === 'locked')
}));

vi.mock('@qbit/wallet-state', () => ({
  useAddressTypeSettingLogic: () => harness.addressType,
  useI18n: () => ({ t: (key: string) => key, locale: 'fr' }),
  // What the lock settings read; see the note on the building blocks above.
  useAutoLockTimeId: () => 2,
  useBiometricUnlock: () => ({ ready: true, supported: true, enrolled: false }),
  useSecurityCardLogic: () => ({
    lockOnComputerLock: true,
    lockOnWindowsClosed: true,
    saving: false,
    changeLockOnComputerLock: vi.fn(),
    changeLockOnWindowsClosed: vi.fn()
  })
}));

const LANGUAGE = 'advanced-language-row';
const ADDRESS_TYPE = 'advanced-address-type-row';
const REGTEST = 'regtest-access-card';
/**
 * What Address Type says for an HD wallet: the type, its HD path and the
 * account index. (String.raw only so that its apostrophes need neither
 * escapes nor double quotes.)
 */
const HD_WALLET_VALUE = String.raw`Taproot (P2TR) (m/86'/0'/0'/0/3)`;

/** What the screen lists, top to bottom: every child of its content, by test id. */
const listed = () =>
  Array.from(screen.getByTestId('screen-content').children).map((entry) => entry.getAttribute('data-testid'));

/** Renders the screen and lets its short loading state pass. */
function renderScreen() {
  const view = render(<AdvancedScreen />);
  expect(view.container.textContent).toBe('loading');
  act(() => {
    vi.advanceTimersByTime(300);
  });
  return view;
}

describe('AdvancedScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.routerNavigate = vi.fn();
    harness.addressType = { label: 'address_type', value: HD_WALLET_VALUE, onClick: vi.fn() };
    // A store build: Local Regtest is behind the optional permission.
    harness.regtest = { state: 'locked', gated: true };
    // The lock switches show where the browser has these APIs.
    vi.stubGlobal('chrome', {
      idle: { onStateChanged: { addListener: vi.fn() } },
      windows: { onRemoved: { addListener: vi.fn() }, getAll: vi.fn() }
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists exactly Language, Address Type and Local Regtest, in that order', () => {
    renderScreen();

    expect(screen.getByText('advanced_settings')).toBeTruthy();
    expect(listed()).toEqual([LANGUAGE, ADDRESS_TYPE, REGTEST]);
    expect(screen.getByTestId(LANGUAGE).textContent).toBe('languageFrançais');
    expect(screen.getByTestId(ADDRESS_TYPE).textContent).toBe(`address_type${HD_WALLET_VALUE}`);
    expect(screen.getByTestId(REGTEST).textContent).toBe('local_regtestregtest_access_status_off');
  });

  it.each([
    [
      'in a build that does not gate Local Regtest, as the E2E and local builds are',
      { state: 'available', gated: false }
    ],
    ['before the state of Local Regtest is read', null]
  ])('lists only Language and Address Type %s', (_case, regtest) => {
    harness.regtest = regtest;
    renderScreen();

    expect(listed()).toEqual([LANGUAGE, ADDRESS_TYPE]);
  });

  // They are on the Security screen.
  it('lists none of the lock settings, nor phishing protection, nor a Security row', () => {
    const { container } = renderScreen();

    for (const id of [
      'touch-id-settings-row',
      'security_autoLockTime',
      'lock-on-computer-lock-row',
      'lock-on-windows-closed-row',
      'phishing-protection-card',
      'phishing-protection-state'
    ]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(container.querySelectorAll('[data-testid^="security_"]')).toHaveLength(0);
    expect(container.querySelector('[role="switch"]')).toBeNull();
    for (const label of [
      'touch_id_unlock',
      'automatic_lock_time',
      'lock_when_computer_locks',
      'lock_when_all_windows_close',
      'phishing_protection',
      'change_password',
      'reset_wallet'
    ]) {
      expect(screen.queryByText(label), label).toBeNull();
    }
  });

  it('opens the language screen from Language', () => {
    renderScreen();

    fireEvent.click(screen.getByTestId(LANGUAGE));

    expect(harness.routerNavigate).toHaveBeenCalledWith('/settings/language');
    expect(harness.addressType.onClick).not.toHaveBeenCalled();
  });

  it('leaves what a tap on Address Type does to its logic', () => {
    renderScreen();

    fireEvent.click(screen.getByTestId(ADDRESS_TYPE));

    expect(harness.addressType.onClick).toHaveBeenCalledTimes(1);
    expect(harness.routerNavigate).not.toHaveBeenCalled();
  });

  it('opens the Local Regtest screen from Local Regtest', () => {
    renderScreen();

    fireEvent.click(screen.getByTestId(REGTEST));

    expect(harness.routerNavigate).toHaveBeenCalledWith('/settings/regtest-access');
  });

  it('goes one step back in history', () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    renderScreen();

    fireEvent.click(screen.getByText('back'));

    expect(go).toHaveBeenCalledWith(-1);
    go.mockRestore();
  });
});
