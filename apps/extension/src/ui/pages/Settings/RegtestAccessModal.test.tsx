import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestRegtestHostPermission } from '@/ui/utils/regtestPermission';
import { useI18n, useWallet } from '@qbit/wallet-state';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import RegtestAccessModal from './RegtestAccessModal';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children, 'data-testid': dataTestId }: { children?: ReactNode; 'data-testid'?: string }) =>
    React.createElement('div', { 'data-testid': dataTestId }, children);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
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
  }) => React.createElement('button', { onClick, disabled, 'data-testid': dataTestId }, text);
  const Checkbox = ({
    checked,
    onChange,
    children,
    'data-testid': dataTestId
  }: {
    checked?: boolean;
    onChange?: (e: { target: { checked: boolean } }) => void;
    children?: ReactNode;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'label',
      null,
      React.createElement('input', {
        type: 'checkbox',
        checked: !!checked,
        'data-testid': dataTestId,
        onChange: (e: { target: { checked: boolean } }) => onChange?.({ target: { checked: e.target.checked } })
      }),
      children
    );
  return { Button, Checkbox, Column: Container, Row: Container, Text };
});

vi.mock('@/ui/theme/colors', () => ({ colors: { overlay: '', surface: '', border: '', shadow: '' } }));

vi.mock('@/ui/utils/regtestPermission', () => ({
  requestRegtestHostPermission: vi.fn()
}));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useWallet: vi.fn()
}));

const available = { state: 'available', gated: true, permission: true, acknowledged: true, supported: true } as const;
const unreachable = { ...available, state: 'unreachable', reason: 'network_error' } as const;
const unexpected = { ...available, state: 'unexpected_service', reason: 'genesis_mismatch' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => act(async () => undefined);

describe('RegtestAccessModal', () => {
  const wallet = {
    acknowledgeRegtestAccess: vi.fn(),
    verifyRegtestAccess: vi.fn()
  };
  const onBack = vi.fn();
  const onEnabled = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useWallet).mockReturnValue(wallet as any);
    vi.mocked(requestRegtestHostPermission).mockResolvedValue(true);
    wallet.acknowledgeRegtestAccess.mockResolvedValue(available);
    wallet.verifyRegtestAccess.mockResolvedValue(available);
  });

  async function renderModal() {
    render(<RegtestAccessModal onBack={onBack} onEnabled={onEnabled} />);
    await flush();
    return {
      enable: () => screen.getByTestId('regtest-access-enable') as HTMLButtonElement,
      understand: () => screen.getByTestId('regtest-access-understand') as HTMLInputElement,
      back: () => screen.getByTestId('regtest-access-back') as HTMLButtonElement
    };
  }

  it('keeps Enable disabled until the acknowledgement is checked and shows the explanation', async () => {
    const modal = await renderModal();
    expect(screen.getByText('enable_local_regtest_title')).toBeTruthy();
    expect(screen.getByText('regtest_access_no_value')).toBeTruthy();
    expect(screen.getByText('regtest_access_trust_note')).toBeTruthy();
    // The disable note is its own paragraph, and the old feature description is gone.
    expect(screen.getByText('regtest_access_disable_note')).toBeTruthy();
    expect(screen.queryByText('regtest_access_explanation')).toBeNull();
    expect(screen.getByText('regtest_access_acknowledgement')).toBeTruthy();
    expect(modal.enable().textContent).toBe('enable');
    expect(modal.back().textContent).toBe('cancel');
    expect(modal.enable().disabled).toBe(true);

    fireEvent.click(modal.enable());
    expect(requestRegtestHostPermission).not.toHaveBeenCalled();

    fireEvent.click(modal.understand());
    expect(modal.enable().disabled).toBe(false);
  });

  it('Cancel and backdrop clicks never grant, persist, or request anything', async () => {
    const modal = await renderModal();
    fireEvent.click(modal.understand());

    const backdrop = document.querySelector('.popover-container') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(modal.back());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(requestRegtestHostPermission).not.toHaveBeenCalled();
    expect(wallet.acknowledgeRegtestAccess).not.toHaveBeenCalled();
    expect(onEnabled).not.toHaveBeenCalled();
  });

  it('calls chrome.permissions.request synchronously from the button gesture before any other work', async () => {
    const pending = deferred<boolean>();
    vi.mocked(requestRegtestHostPermission).mockReturnValue(pending.promise);
    const modal = await renderModal();
    fireEvent.click(modal.understand());

    fireEvent.click(modal.enable());
    // Synchronous: asserted before yielding to the event loop.
    expect(requestRegtestHostPermission).toHaveBeenCalledTimes(1);
    expect(wallet.acknowledgeRegtestAccess).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(true);
    });
    await flush();
    expect(wallet.acknowledgeRegtestAccess).toHaveBeenCalledTimes(1);
    expect(onEnabled).toHaveBeenCalledWith(available);
  });

  it('shows a calm denial result, records nothing, and does not prompt again', async () => {
    vi.mocked(requestRegtestHostPermission).mockResolvedValue(false);
    const modal = await renderModal();
    fireEvent.click(modal.understand());
    fireEvent.click(modal.enable());
    await flush();

    expect(screen.getByTestId('regtest-access-result').textContent).toBe('regtest_access_denied');
    expect(wallet.acknowledgeRegtestAccess).not.toHaveBeenCalled();
    expect(onEnabled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('regtest-access-retry')).toBeNull();
    expect(requestRegtestHostPermission).toHaveBeenCalledTimes(1);

    fireEvent.click(modal.back());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('reports a browser API failure distinctly without re-prompting', async () => {
    vi.mocked(requestRegtestHostPermission).mockRejectedValue(new Error('boom'));
    const modal = await renderModal();
    fireEvent.click(modal.understand());
    fireEvent.click(modal.enable());
    await flush();

    expect(screen.getByTestId('regtest-access-result').textContent).toBe('regtest_access_request_failed');
    expect(wallet.acknowledgeRegtestAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId('regtest-access-retry')).toBeNull();
    expect(requestRegtestHostPermission).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an unreachable service and retries verification without a new prompt', async () => {
    wallet.acknowledgeRegtestAccess.mockResolvedValue(unreachable);
    const modal = await renderModal();
    fireEvent.click(modal.understand());
    fireEvent.click(modal.enable());
    await flush();

    expect(screen.getByTestId('regtest-access-result').textContent).toBe('regtest_service_unavailable');
    expect(onEnabled).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('regtest-access-retry'));
    await flush();
    expect(wallet.verifyRegtestAccess).toHaveBeenCalledTimes(1);
    expect(requestRegtestHostPermission).toHaveBeenCalledTimes(1);
    expect(onEnabled).toHaveBeenCalledWith(available);
  });

  it('distinguishes an unexpected service at the address', async () => {
    wallet.acknowledgeRegtestAccess.mockResolvedValue(unexpected);
    const modal = await renderModal();
    fireEvent.click(modal.understand());
    fireEvent.click(modal.enable());
    await flush();

    expect(screen.getByTestId('regtest-access-result').textContent).toBe('regtest_service_unexpected');
    expect(screen.getByTestId('regtest-access-retry')).toBeTruthy();
    expect(onEnabled).not.toHaveBeenCalled();
  });

  it('shows the locked error when the background does not observe the grant', async () => {
    wallet.acknowledgeRegtestAccess.mockResolvedValue({ ...available, state: 'locked', permission: false });
    const modal = await renderModal();
    fireEvent.click(modal.understand());
    fireEvent.click(modal.enable());
    await flush();

    expect(screen.getByTestId('regtest-access-result').textContent).toBe('regtest_access_not_enabled');
    expect(onEnabled).not.toHaveBeenCalled();
  });
});
