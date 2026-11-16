import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { colors } from '@/ui/theme/colors';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyringType } from '@qbit/wallet-shared';

import SecurityScreen from './index';

const harness = vi.hoisted(
  () =>
    ({}) as {
      navigate: Mock;
      routerNavigate: Mock;
      currentKeyring: { key: string; type: string };
      biometric: { ready: boolean; supported: boolean; enrolled: boolean };
      lockTimeId: number;
      locks: {
        lockOnComputerLock: boolean | undefined;
        lockOnWindowsClosed: boolean | undefined;
        saving: boolean;
        changeLockOnComputerLock: Mock;
        changeLockOnWindowsClosed: Mock;
      };
      readPhishingProtection: Mock;
    }
);

// The screen's own parts are real here: its rows, the lock settings among
// them, and the phishing card. Only the building blocks they draw with, the
// wallet's state and the background's answers are stand-ins.
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
    Button: ({
      text,
      onClick,
      'data-testid': testId
    }: {
      text?: string;
      onClick?: () => void;
      'data-testid'?: string;
    }) => React.createElement('button', { onClick, 'data-testid': testId }, text),
    Card: Container,
    Column: Container,
    Content: ({ children }: { children?: ReactNode }) =>
      React.createElement('main', { 'data-testid': 'screen-content' }, children),
    Layout: Container,
    Row: Container,
    Header: ({ title, onBack }: { title?: string; onBack?: () => void }) =>
      React.createElement('header', null, React.createElement('button', { onClick: onBack }, 'back'), title),
    Icon: ({ icon, color }: { icon?: string; color?: string }) =>
      React.createElement('i', { 'data-icon': icon, 'data-color': color }),
    Switch: ({
      checked,
      disabled,
      onChange
    }: {
      checked?: boolean;
      disabled?: boolean;
      onChange?: (checked: boolean) => void;
    }) =>
      React.createElement('button', {
        role: 'switch',
        'aria-checked': String(checked),
        'data-disabled': String(!!disabled),
        onClick: () => onChange?.(!checked)
      }),
    Text: ({ text, style, 'data-testid': testId }: { text?: string; style?: CSSProperties; 'data-testid'?: string }) =>
      React.createElement('span', { style, 'data-testid': testId }, text)
  };
});

// The dialog has its own tests; here it only has to open and close.
vi.mock('@/ui/components/ResetWalletPopover', async () => {
  const React = await import('react');
  return {
    ResetWalletPopover: ({
      lastWalletKey,
      outdated,
      onClose
    }: {
      lastWalletKey?: string;
      outdated?: boolean;
      onClose: () => void;
    }) =>
      React.createElement(
        'div',
        {
          'data-testid': 'reset-wallet-dialog',
          'data-last-wallet-key': String(lastWalletKey ?? ''),
          'data-outdated': String(outdated === true)
        },
        React.createElement('button', { onClick: onClose }, 'close-reset')
      )
  };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => harness.routerNavigate }));

vi.mock('@qbit/wallet-state', () => ({
  useAutoLockTimeId: () => harness.lockTimeId,
  useBiometricUnlock: () => harness.biometric,
  useCurrentKeyring: () => harness.currentKeyring,
  useI18n: () => ({
    t: (key: string, substitutions?: string | string[]) =>
      substitutions === undefined ? key : `${key}(${[substitutions].flat().join('|')})`
  }),
  useNavigation: () => ({ navigate: harness.navigate }),
  useSecurityCardLogic: () => harness.locks
}));

// What the background says of phishing protection; the card's own handling
// of it has its tests beside the card.
vi.mock('./phishingProtection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./phishingProtection')>()),
  readPhishingProtection: () => harness.readPhishingProtection()
}));

const CHANGE_PASSWORD = 'security_changePassword';
const SHOW_PHRASE = 'security_showSeedPhrase';
const TOUCH_ID = 'touch-id-settings-row';
const LOCK_TIME = 'security_autoLockTime';
const COMPUTER_LOCK = 'lock-on-computer-lock-row';
const WINDOWS_CLOSED = 'lock-on-windows-closed-row';
const PHISHING = 'phishing-protection-card';
const RESET = 'security_resetWallet';

const listener = { addListener: vi.fn() };

/** What the screen lists, top to bottom: every child of its one list, by test id. */
const listed = () => {
  const list = screen.getByTestId(CHANGE_PASSWORD).parentElement as HTMLElement;
  // The list is the screen's whole content: nothing is drawn beside it.
  expect(Array.from(screen.getByTestId('screen-content').children)).toEqual([list]);
  return Array.from(list.children).map((row) => row.getAttribute('data-testid'));
};
const labelOf = (id: string) => screen.getByTestId(id).querySelector('span') as HTMLElement;
const iconOf = (id: string) => screen.getByTestId(id).querySelector('i') as HTMLElement;
const switchOf = (id: string) => screen.getByTestId(id).querySelector('[role="switch"]') as HTMLElement;

/** Renders the screen and lets the phishing card's first read land. */
async function renderScreen() {
  const view = render(<SecurityScreen />);
  await act(async () => undefined);
  return view;
}

describe('SecurityScreen', () => {
  beforeEach(() => {
    harness.navigate = vi.fn();
    harness.routerNavigate = vi.fn();
    harness.currentKeyring = { key: 'keyring_0', type: KeyringType.QbitHdKeyring };
    harness.biometric = { ready: true, supported: true, enrolled: false };
    // 5 minutes.
    harness.lockTimeId = 3;
    harness.locks = {
      lockOnComputerLock: true,
      lockOnWindowsClosed: false,
      saving: false,
      changeLockOnComputerLock: vi.fn(),
      changeLockOnWindowsClosed: vi.fn()
    };
    harness.readPhishingProtection = vi.fn(async () => ({
      state: 'protected',
      reasons: [],
      networkRules: { status: 'installed', attempts: 1, blockedDomains: 120, skippedEntries: [], updatedAt: 0 }
    }));
    // An MV3 build: the browser has both lock APIs.
    vi.stubGlobal('chrome', {
      idle: { onStateChanged: listener },
      windows: { onRemoved: listener, getAll: vi.fn() }
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '#/');
  });

  it('lists, in order: Change Password, Touch ID, the recovery phrase, the lock time, the two lock switches, phishing protection, and Reset Wallet last', async () => {
    await renderScreen();

    expect(screen.getByText('security')).toBeTruthy();
    expect(listed()).toEqual([
      CHANGE_PASSWORD,
      TOUCH_ID,
      SHOW_PHRASE,
      LOCK_TIME,
      COMPUTER_LOCK,
      WINDOWS_CLOSED,
      PHISHING,
      RESET
    ]);
    expect(labelOf(CHANGE_PASSWORD).textContent).toBe('change_password');
    expect(labelOf(TOUCH_ID).textContent).toBe('touch_id_unlock');
    expect(labelOf(SHOW_PHRASE).textContent).toBe('show_secret_recovery_phrase');
    expect(labelOf(LOCK_TIME).textContent).toBe('automatic_lock_time');
    expect(labelOf(COMPUTER_LOCK).textContent).toBe('lock_when_computer_locks');
    expect(labelOf(WINDOWS_CLOSED).textContent).toBe('lock_when_all_windows_close');
    expect(labelOf(PHISHING).textContent).toBe('phishing_protection');
    expect(labelOf(RESET).textContent).toBe('reset_wallet');
  });

  it.each([
    KeyringType.SimpleKeyring,
    KeyringType.ReadonlyKeyring,
    KeyringType.WatchAddressKeyring,
    KeyringType.ColdWalletKeyring,
    'Other Key Type',
    // No wallet in the store.
    ''
  ])('lists the same without the recovery phrase for a %s wallet, which has none', async (type) => {
    harness.currentKeyring = { key: 'keyring_1', type };
    await renderScreen();

    expect(listed()).toEqual([CHANGE_PASSWORD, TOUCH_ID, LOCK_TIME, COMPUTER_LOCK, WINDOWS_CLOSED, PHISHING, RESET]);
  });

  it('gives every row the one look: an icon, then the label, on a row of its own', async () => {
    await renderScreen();

    expect(
      [CHANGE_PASSWORD, TOUCH_ID, SHOW_PHRASE, LOCK_TIME, COMPUTER_LOCK, WINDOWS_CLOSED, PHISHING, RESET].map((id) =>
        iconOf(id).getAttribute('data-icon')
      )
    ).toEqual([
      'changePassword',
      'touchId',
      'recoveryPhrase',
      'lockTime',
      'computerLock',
      'windowsClose',
      'phishingProtection',
      'reset'
    ]);
    // A row that opens a screen ends with the chevron; a switch row ends with its switch.
    for (const id of [CHANGE_PASSWORD, TOUCH_ID, SHOW_PHRASE, LOCK_TIME, RESET]) {
      expect(screen.getByTestId(id).querySelector('[data-icon="right"]'), id).not.toBeNull();
      expect(switchOf(id), id).toBeNull();
    }
    for (const id of [COMPUTER_LOCK, WINDOWS_CLOSED]) {
      expect(screen.getByTestId(id).querySelector('[data-icon="right"]'), id).toBeNull();
      expect(switchOf(id), id).not.toBeNull();
    }
  });

  it('opens Change Password', async () => {
    await renderScreen();

    fireEvent.click(screen.getByTestId(CHANGE_PASSWORD));

    expect(harness.navigate).toHaveBeenCalledWith('ChangePasswordScreen');
    expect(harness.routerNavigate).not.toHaveBeenCalled();
  });

  it.each([KeyringType.HdKeyring, KeyringType.QbitHdKeyring])(
    'shows the recovery phrase of the current %s wallet, as the switcher does',
    async (type) => {
      harness.currentKeyring = { key: 'keyring_3', type };
      await renderScreen();

      fireEvent.click(screen.getByTestId(SHOW_PHRASE));

      expect(harness.navigate).toHaveBeenCalledWith('ExportMnemonicsScreen', { keyring: harness.currentKeyring });
    }
  );

  describe('Touch ID Unlock', () => {
    it.each([
      [true, 'touch_id_status_on'],
      [false, 'touch_id_status_off']
    ])('shows its state (enrolled: %s) and opens the Touch ID screen', async (enrolled, status) => {
      harness.biometric = { ready: true, supported: true, enrolled };
      await renderScreen();

      expect(screen.getByTestId(TOUCH_ID).textContent).toBe(`touch_id_unlock${status}`);
      fireEvent.click(screen.getByTestId(TOUCH_ID));

      expect(harness.routerNavigate).toHaveBeenCalledWith('/settings/biometric');
      expect(harness.routerNavigate).toHaveBeenCalledTimes(1);
      expect(harness.navigate).not.toHaveBeenCalled();
    });

    it.each([
      ['before the browser has answered', { ready: false, supported: true, enrolled: false }],
      ['where the browser cannot do it', { ready: true, supported: false, enrolled: false }],
      ['where neither holds', { ready: false, supported: false, enrolled: true }]
    ])('is not listed %s, and the recovery phrase follows Change Password directly', async (_case, biometric) => {
      harness.biometric = biometric;
      await renderScreen();

      expect(listed()).toEqual([
        CHANGE_PASSWORD,
        SHOW_PHRASE,
        LOCK_TIME,
        COMPUTER_LOCK,
        WINDOWS_CLOSED,
        PHISHING,
        RESET
      ]);
    });

    it('is not listed, nor the recovery phrase, for a wallet without a phrase where the browser cannot do Touch ID', async () => {
      harness.biometric = { ready: true, supported: false, enrolled: false };
      harness.currentKeyring = { key: 'keyring_1', type: KeyringType.SimpleKeyring };
      await renderScreen();

      expect(listed()).toEqual([CHANGE_PASSWORD, LOCK_TIME, COMPUTER_LOCK, WINDOWS_CLOSED, PHISHING, RESET]);
    });
  });

  it('shows the chosen lock time and opens the lock time screen', async () => {
    await renderScreen();

    expect(screen.getByTestId(LOCK_TIME).textContent).toBe('automatic_lock_timen_minutes(5)');
    fireEvent.click(screen.getByTestId(LOCK_TIME));

    expect(harness.routerNavigate).toHaveBeenCalledWith('/settings/lock-time');
    expect(harness.routerNavigate).toHaveBeenCalledTimes(1);
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  describe('the lock switches', () => {
    it('show the stored values, and only the switch itself changes a setting', async () => {
      await renderScreen();

      expect(switchOf(COMPUTER_LOCK).getAttribute('aria-checked')).toBe('true');
      expect(switchOf(WINDOWS_CLOSED).getAttribute('aria-checked')).toBe('false');

      // The row around a switch does nothing: it opens no screen.
      fireEvent.click(labelOf(COMPUTER_LOCK));
      fireEvent.click(labelOf(WINDOWS_CLOSED));
      expect(harness.locks.changeLockOnComputerLock).not.toHaveBeenCalled();
      expect(harness.locks.changeLockOnWindowsClosed).not.toHaveBeenCalled();

      fireEvent.click(switchOf(COMPUTER_LOCK));
      expect(harness.locks.changeLockOnComputerLock).toHaveBeenCalledWith(false);
      expect(harness.locks.changeLockOnWindowsClosed).not.toHaveBeenCalled();
      fireEvent.click(switchOf(WINDOWS_CLOSED));
      expect(harness.locks.changeLockOnWindowsClosed).toHaveBeenCalledWith(true);

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.routerNavigate).not.toHaveBeenCalled();
    });

    it('are both held while a change saves', async () => {
      harness.locks.saving = true;
      await renderScreen();

      expect(switchOf(COMPUTER_LOCK).getAttribute('data-disabled')).toBe('true');
      expect(switchOf(WINDOWS_CLOSED).getAttribute('data-disabled')).toBe('true');
    });

    it('are not listed before their settings are read', async () => {
      harness.locks.lockOnComputerLock = undefined;
      harness.locks.lockOnWindowsClosed = undefined;
      await renderScreen();

      expect(listed()).toEqual([CHANGE_PASSWORD, TOUCH_ID, SHOW_PHRASE, LOCK_TIME, PHISHING, RESET]);
    });

    it('lists no computer-lock switch in a build without chrome.idle, as MV2 builds are', async () => {
      vi.stubGlobal('chrome', { windows: { onRemoved: listener, getAll: vi.fn() } });
      await renderScreen();

      expect(listed()).toEqual([CHANGE_PASSWORD, TOUCH_ID, SHOW_PHRASE, LOCK_TIME, WINDOWS_CLOSED, PHISHING, RESET]);
    });

    it('lists no windows switch where the browser has no windows API, and neither outside an extension', async () => {
      vi.stubGlobal('chrome', { idle: { onStateChanged: listener } });
      await renderScreen();
      expect(listed()).toEqual([CHANGE_PASSWORD, TOUCH_ID, SHOW_PHRASE, LOCK_TIME, COMPUTER_LOCK, PHISHING, RESET]);
      cleanup();

      vi.stubGlobal('chrome', undefined);
      await renderScreen();
      expect(listed()).toEqual([CHANGE_PASSWORD, TOUCH_ID, SHOW_PHRASE, LOCK_TIME, PHISHING, RESET]);
    });
  });

  describe('phishing protection', () => {
    it('shows the card with the state the background reports, between the lock settings and Reset Wallet', async () => {
      await renderScreen();

      const card = screen.getByTestId(PHISHING);
      expect(harness.readPhishingProtection).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('phishing-protection-state').textContent).toBe('phishing_protection_status_protected');
      expect(card.textContent).toContain('phishing_protection_blocked_domains(120)');
      expect(card.textContent).toContain('phishing_protection_list_note');
      // Fully on: nothing to retry.
      expect(screen.queryByTestId('phishing-protection-retry')).toBeNull();

      const order = listed();
      expect(order.indexOf(PHISHING)).toBe(order.indexOf(WINDOWS_CLOSED) + 1);
      expect(order.indexOf(RESET)).toBe(order.indexOf(PHISHING) + 1);
      expect(order.at(-1)).toBe(RESET);
    });

    it('shows why protection is not full, with Retry, and stays above Reset Wallet', async () => {
      harness.readPhishingProtection = vi.fn(async () => ({
        state: 'degraded',
        reasons: ['site-access-withheld'],
        networkRules: { status: 'installed', attempts: 1, blockedDomains: 120, skippedEntries: [], updatedAt: 0 }
      }));
      await renderScreen();

      expect(screen.getByTestId('phishing-protection-state').textContent).toBe('phishing_protection_status_degraded');
      expect(screen.getByTestId('phishing-protection-reason').textContent).toBe(
        'phishing_protection_reason_site_access_withheld'
      );
      expect(screen.getByTestId('phishing-protection-retry')).toBeTruthy();
      expect(listed().slice(-2)).toEqual([PHISHING, RESET]);
    });

    it('is listed before its first read lands, so nothing below it moves up meanwhile', async () => {
      harness.readPhishingProtection = vi.fn(() => new Promise(() => undefined));
      await renderScreen();

      expect(screen.queryByTestId('phishing-protection-state')).toBeNull();
      expect(listed().slice(-2)).toEqual([PHISHING, RESET]);
    });
  });

  it('shows Reset Wallet in red, last, and opens the reset dialog', async () => {
    await renderScreen();

    expect(listed().at(-1)).toBe(RESET);
    expect(labelOf(RESET).style.color).toBe(colors.dangerText);
    expect(iconOf(RESET).getAttribute('data-color')).toBe('dangerText');
    // No other row is a danger row.
    for (const id of [CHANGE_PASSWORD, TOUCH_ID, SHOW_PHRASE, LOCK_TIME, COMPUTER_LOCK, WINDOWS_CLOSED]) {
      expect(labelOf(id).style.color, id).toBe(colors.text);
      expect(iconOf(id).getAttribute('data-color'), id).toBe('textDim');
    }
    expect(screen.queryByTestId('reset-wallet-dialog')).toBeNull();

    fireEvent.click(screen.getByTestId(RESET));

    // The Settings entry, not the last-wallet one from the switcher.
    expect(screen.getByTestId('reset-wallet-dialog').getAttribute('data-last-wallet-key')).toBe('');
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.routerNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('close-reset'));
    expect(screen.queryByTestId('reset-wallet-dialog')).toBeNull();
  });

  // Opened from Settings, a reset rests on no premise about the wallets.
  it('keeps the reset dialog open, never outdated, whatever the current wallet becomes', async () => {
    const { rerender } = await renderScreen();
    fireEvent.click(screen.getByTestId(RESET));

    for (const keyring of [
      { key: 'keyring_4', type: KeyringType.SimpleKeyring },
      { key: '', type: '' },
      { key: 'keyring_5', type: KeyringType.HdKeyring }
    ]) {
      harness.currentKeyring = keyring;
      rerender(<SecurityScreen />);
      expect(screen.getByTestId('reset-wallet-dialog').getAttribute('data-outdated')).toBe('false');
    }
  });

  it('goes back to Settings when it is the first history entry', async () => {
    window.history.replaceState({ idx: 0 }, '', '#/settings/security');
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    await renderScreen();

    fireEvent.click(screen.getByText('back'));

    expect(harness.routerNavigate).toHaveBeenCalledWith('/settings', { replace: true });
    expect(go).not.toHaveBeenCalled();

    window.history.replaceState({ idx: 2 }, '', '#/settings/security');
    fireEvent.click(screen.getByText('back'));
    expect(go).toHaveBeenCalledWith(-1);
    expect(harness.routerNavigate).toHaveBeenCalledTimes(1);
    go.mockRestore();
  });
});
