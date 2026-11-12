import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import ChangePasswordScreen from './ChangePasswordScreen';

const routerNavigate = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return {
    Button: ({ text }: { text?: string }) => React.createElement('button', null, text),
    Column: Container,
    Content: Container,
    Header: ({ onBack }: { onBack?: () => void }) => React.createElement('button', { onClick: onBack }, 'back'),
    Input: () => React.createElement('input'),
    Layout: Container,
    Row: Container,
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('react-router-dom', () => ({
  useNavigate:
    () =>
    (...args: unknown[]) =>
      routerNavigate.calls.push(args)
}));

// The route table would load every screen.
vi.mock('../MainRoute', () => ({ useNavigate: () => vi.fn() }));

vi.mock('@qbit/wallet-state', () => ({
  useBiometricUnlock: () => ({ changePasswordKeepingBiometric: vi.fn() }),
  useI18n: () => ({ t: (key: string) => key }),
  useTools: () => ({ toastError: vi.fn(), toastSuccess: vi.fn() })
}));

describe('ChangePasswordScreen Back', () => {
  let go: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerNavigate.calls = [];
    go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    go.mockRestore();
    window.history.replaceState(null, '', '#/');
  });

  it('rebuilds Settings → Security when the screen is the first history entry', () => {
    window.history.replaceState({ idx: 0 }, '', '#/settings/password');
    render(<ChangePasswordScreen />);

    fireEvent.click(screen.getByText('back'));

    // Settings replaces this entry and Security is pushed on it, so this Back
    // lands on Security and Security's own Back on Settings.
    expect(routerNavigate.calls).toEqual([['/settings', { replace: true }], ['/settings/security']]);
    expect(go).not.toHaveBeenCalled();
  });

  it('goes back in history when there is a screen behind it', () => {
    window.history.replaceState({ idx: 3 }, '', '#/settings/password');
    render(<ChangePasswordScreen />);

    fireEvent.click(screen.getByText('back'));

    expect(go).toHaveBeenCalledWith(-1);
    expect(routerNavigate.calls).toEqual([]);
  });
});
