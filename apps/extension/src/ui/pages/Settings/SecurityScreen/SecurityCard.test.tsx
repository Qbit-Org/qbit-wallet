import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoLockTimeId, useBiometricUnlock, useI18n, useSecurityCardLogic } from '@qbit/wallet-state';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import en from '../../../../_locales/en/messages.json';
import es from '../../../../_locales/es/messages.json';
import fr from '../../../../_locales/fr/messages.json';
import ja from '../../../../_locales/ja/messages.json';
import ru from '../../../../_locales/ru/messages.json';
import zhTW from '../../../../_locales/zh_TW/messages.json';
import { SecurityCard, TouchIdUnlockRow } from './SecurityCard';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    onClick,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { 'data-testid': rest['data-testid'], onClick }, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  // The real switch: what assistive technology and the keyboard get from it.
  const { Switch } = await import('@/ui/components/Switch');
  return { Card: Container, Column: Container, Icon: Container, Row: Container, Switch, Text };
});

const navigate = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock('react-router-dom', () => ({ useNavigate: () => (path: string) => navigate.to.push(path) }));

vi.mock('@qbit/wallet-state', () => ({
  useAutoLockTimeId: vi.fn(),
  useBiometricUnlock: vi.fn(),
  useI18n: vi.fn(),
  useSecurityCardLogic: vi.fn()
}));

const listener = { addListener: vi.fn() };
const COMPUTER_LOCK_ROW = 'lock-on-computer-lock-row';
const WINDOWS_CLOSED_ROW = 'lock-on-windows-closed-row';

// The lock settings by themselves; the Security screen's own test has them in
// its list, in order, among the screen's other rows.
describe('SecurityCard lock switches', () => {
  const logic = {
    lockOnComputerLock: true as boolean | undefined,
    lockOnWindowsClosed: false as boolean | undefined,
    saving: false,
    changeLockOnComputerLock: vi.fn(),
    changeLockOnWindowsClosed: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    navigate.to = [];
    logic.lockOnComputerLock = true;
    logic.lockOnWindowsClosed = false;
    logic.saving = false;
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useAutoLockTimeId).mockReturnValue(5);
    vi.mocked(useBiometricUnlock).mockReturnValue({ ready: false, supported: false, enrolled: false } as any);
    vi.mocked(useSecurityCardLogic).mockImplementation(() => logic as ReturnType<typeof useSecurityCardLogic>);
    // An MV3 build: both APIs are there.
    vi.stubGlobal('chrome', {
      idle: { onStateChanged: listener },
      windows: { onRemoved: listener, getAll: vi.fn() }
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows both switches with the stored values and saves a change', () => {
    render(<SecurityCard />);

    const computer = screen.getByTestId(COMPUTER_LOCK_ROW);
    const windows = screen.getByTestId(WINDOWS_CLOSED_ROW);
    expect(computer.textContent).toContain('lock_when_computer_locks');
    expect(windows.textContent).toContain('lock_when_all_windows_close');
    expect(within(computer).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(windows).getByRole('switch').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(within(computer).getByRole('switch'));
    expect(logic.changeLockOnComputerLock).toHaveBeenCalledWith(false);
    fireEvent.click(within(windows).getByRole('switch'));
    expect(logic.changeLockOnWindowsClosed).toHaveBeenCalledWith(true);
  });

  it(String.raw`names each switch by its row's label`, () => {
    render(<SecurityCard />);

    const computer = screen.getByRole('switch', { name: 'lock_when_computer_locks' });
    const windows = screen.getByRole('switch', { name: 'lock_when_all_windows_close' });
    expect(screen.getByTestId(COMPUTER_LOCK_ROW).contains(computer)).toBe(true);
    expect(screen.getByTestId(WINDOWS_CLOSED_ROW).contains(windows)).toBe(true);
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('saves a change made from the keyboard through the same handlers', () => {
    render(<SecurityCard />);

    fireEvent.keyDown(screen.getByRole('switch', { name: 'lock_when_computer_locks' }), { key: ' ' });
    expect(logic.changeLockOnComputerLock).toHaveBeenCalledTimes(1);
    expect(logic.changeLockOnComputerLock).toHaveBeenCalledWith(false);

    fireEvent.keyDown(screen.getByRole('switch', { name: 'lock_when_all_windows_close' }), { key: 'Enter' });
    expect(logic.changeLockOnWindowsClosed).toHaveBeenCalledTimes(1);
    expect(logic.changeLockOnWindowsClosed).toHaveBeenCalledWith(true);
  });

  it('disables both switches while a change is saved, by mouse and keyboard', () => {
    logic.saving = true;
    render(<SecurityCard />);

    for (const control of screen.getAllByRole('switch')) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(control);
      fireEvent.keyDown(control, { key: ' ' });
      fireEvent.keyDown(control, { key: 'Enter' });
    }
    expect(logic.changeLockOnComputerLock).not.toHaveBeenCalled();
    expect(logic.changeLockOnWindowsClosed).not.toHaveBeenCalled();
  });

  it('shows no switch before the settings are read', () => {
    logic.lockOnComputerLock = undefined;
    logic.lockOnWindowsClosed = undefined;
    render(<SecurityCard />);
    expect(screen.queryByTestId(COMPUTER_LOCK_ROW)).toBeNull();
    expect(screen.queryByTestId(WINDOWS_CLOSED_ROW)).toBeNull();
  });

  it('hides the computer-lock switch in a build without chrome.idle, as MV2 builds are', () => {
    vi.stubGlobal('chrome', { windows: { onRemoved: listener, getAll: vi.fn() } });
    render(<SecurityCard />);
    expect(screen.queryByTestId(COMPUTER_LOCK_ROW)).toBeNull();
    expect(screen.getByTestId(WINDOWS_CLOSED_ROW)).toBeTruthy();
  });

  it('hides the windows switch where the browser has no windows API, and both outside an extension', () => {
    vi.stubGlobal('chrome', { idle: { onStateChanged: listener } });
    render(<SecurityCard />);
    expect(screen.getByTestId(COMPUTER_LOCK_ROW)).toBeTruthy();
    expect(screen.queryByTestId(WINDOWS_CLOSED_ROW)).toBeNull();
    cleanup();

    vi.stubGlobal('chrome', undefined);
    render(<SecurityCard />);
    expect(screen.queryByTestId(COMPUTER_LOCK_ROW)).toBeNull();
    expect(screen.queryByTestId(WINDOWS_CLOSED_ROW)).toBeNull();
  });

  // Change Password and Touch ID Unlock are rows of the Security screen
  // itself, above the recovery phrase, not among these.
  it('offers the auto-lock time and the lock switches, and neither Touch ID nor a way to the password screen', () => {
    vi.mocked(useBiometricUnlock).mockReturnValue({ ready: true, supported: true, enrolled: true } as ReturnType<
      typeof useBiometricUnlock
    >);
    const { container } = render(<SecurityCard />);

    expect(screen.queryByText('change_password')).toBeNull();
    expect(screen.queryByText('touch_id_unlock')).toBeNull();
    expect(screen.queryByTestId('touch-id-settings-row')).toBeNull();
    expect(screen.getByText('automatic_lock_time')).toBeTruthy();
    expect(screen.getByTestId(COMPUTER_LOCK_ROW)).toBeTruthy();
    expect(screen.getByTestId(WINDOWS_CLOSED_ROW)).toBeTruthy();

    container.querySelectorAll('div').forEach((row) => fireEvent.click(row));
    expect(navigate.to).toContain('/settings/lock-time');
    expect(navigate.to).not.toContain('/settings/biometric');
    expect(navigate.to).not.toContain('/settings/password');
  });

  it('has a Touch ID row of its own, where the browser can do Touch ID, that opens the Touch ID screen', () => {
    vi.mocked(useBiometricUnlock).mockReturnValue({ ready: true, supported: true, enrolled: true } as ReturnType<
      typeof useBiometricUnlock
    >);
    render(<TouchIdUnlockRow />);

    const row = screen.getByTestId('touch-id-settings-row');
    expect(row.textContent).toBe('touch_id_unlocktouch_id_status_on');
    fireEvent.click(row);
    expect(navigate.to).toEqual(['/settings/biometric']);
    cleanup();

    for (const biometric of [
      { ready: false, supported: true, enrolled: false },
      { ready: true, supported: false, enrolled: false }
    ]) {
      vi.mocked(useBiometricUnlock).mockReturnValue(biometric as ReturnType<typeof useBiometricUnlock>);
      const { container } = render(<TouchIdUnlockRow />);
      expect(container.childElementCount).toBe(0);
      cleanup();
    }
  });

  // The time shown for each id an earlier, this or a later build stored.
  it.each([
    [0, '5 Minutes'],
    [1, '5 Minutes'],
    [2, '5 Minutes'],
    [3, '5 Minutes'],
    [4, '15 Minutes'],
    [5, '30 Minutes'],
    [6, '1 Hour'],
    [7, '3 Hours'],
    [8, '15 Minutes'],
    [9, '3 Hours'],
    [10, '6 Hours'],
    [11, '5 Minutes']
  ])('shows the auto-lock time stored as %s as %s', (stored, label) => {
    const messages = en as Record<string, { message: string }>;
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, count?: string) => (messages[key]?.message ?? key).replace('$1', count ?? '')
    } as ReturnType<typeof useI18n>);
    vi.mocked(useAutoLockTimeId).mockReturnValue(stored);
    render(<SecurityCard />);

    expect(screen.getByText(label)).toBeTruthy();
  });

  // Russian needs another plural form for 6 than for 3 ("6 Часов", "3 Часа").
  it.each([
    [3, '5 Минут'],
    [8, '15 Минут'],
    [5, '30 Минут'],
    [6, '1 Час'],
    [9, '3 Часа'],
    [10, '6 Часов']
  ])('shows the auto-lock time %s in Russian as %s', (stored, label) => {
    const messages = ru as Record<string, { message: string }>;
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, count?: string) => (messages[key]?.message ?? key).replace('$1', count ?? '')
    } as ReturnType<typeof useI18n>);
    vi.mocked(useAutoLockTimeId).mockReturnValue(stored);
    render(<SecurityCard />);

    expect(screen.getByText(label)).toBeTruthy();
  });

  it('has the auto-lock time labels in every locale', () => {
    for (const messages of [en, es, fr, ja, ru, zhTW] as Record<string, { message: string }>[]) {
      for (const key of ['n_minutes', 'n_hour', 'n_hours', 'n_hours_many']) {
        expect(messages[key]?.message, key).toContain('$1');
      }
    }
  });

  it('has the lock labels and the locked-while-unlocking message in every locale', () => {
    for (const messages of [en, es, fr, ja, ru, zhTW] as Record<string, { message: string }>[]) {
      for (const key of ['lock_when_computer_locks', 'lock_when_all_windows_close', 'wallet_locked_during_unlock']) {
        expect(messages[key]?.message, key).toBeTruthy();
      }
    }
  });
});
