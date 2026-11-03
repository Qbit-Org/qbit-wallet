import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoLockTimeId, useBiometricUnlock, useI18n, useSecurityCardLogic } from '@qbit/wallet-state';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import en from '../../../../_locales/en/messages.json';
import es from '../../../../_locales/es/messages.json';
import fr from '../../../../_locales/fr/messages.json';
import ja from '../../../../_locales/ja/messages.json';
import ru from '../../../../_locales/ru/messages.json';
import zhTW from '../../../../_locales/zh_TW/messages.json';
import { SecurityCard } from './SecurityCard';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, ...rest }: { children?: ReactNode; 'data-testid'?: string }) =>
    React.createElement('div', { 'data-testid': rest['data-testid'] }, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  const Switch = ({ checked, onChange }: { checked?: boolean; onChange?: (checked: boolean) => void }) =>
    React.createElement('button', { 'data-checked': String(checked), onClick: () => onChange?.(!checked) });
  return { Card: Container, Column: Container, Icon: Container, Row: Container, Switch, Text };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('@qbit/wallet-state', () => ({
  useAutoLockTimeId: vi.fn(),
  useBiometricUnlock: vi.fn(),
  useI18n: vi.fn(),
  useSecurityCardLogic: vi.fn()
}));

const listener = { addListener: vi.fn() };
const COMPUTER_LOCK_ROW = 'lock-on-computer-lock-row';
const WINDOWS_CLOSED_ROW = 'lock-on-windows-closed-row';

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
    logic.lockOnComputerLock = true;
    logic.lockOnWindowsClosed = false;
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useAutoLockTimeId).mockReturnValue(2);
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
    expect(computer.querySelector('button')?.getAttribute('data-checked')).toBe('true');
    expect(windows.querySelector('button')?.getAttribute('data-checked')).toBe('false');

    fireEvent.click(computer.querySelector('button')!);
    expect(logic.changeLockOnComputerLock).toHaveBeenCalledWith(false);
    fireEvent.click(windows.querySelector('button')!);
    expect(logic.changeLockOnWindowsClosed).toHaveBeenCalledWith(true);
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

  it('has the lock labels and the locked-while-unlocking message in every locale', () => {
    for (const messages of [en, es, fr, ja, ru, zhTW] as Record<string, { message: string }>[]) {
      for (const key of ['lock_when_computer_locks', 'lock_when_all_windows_close', 'wallet_locked_during_unlock']) {
        expect(messages[key]?.message, key).toBeTruthy();
      }
    }
  });
});
