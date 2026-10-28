import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '@qbit/wallet-shared';
import { useI18n, useTools, useWallet } from '@qbit/wallet-state';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EnableSignDataCard } from './EnableSignData';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  const Switch = ({ checked, onChange }: { checked?: boolean; onChange?: () => void }) =>
    React.createElement('button', {
      'data-testid': 'sign-data-switch',
      'data-checked': String(checked),
      onClick: onChange
    });
  return {
    Button: Container,
    Card: Container,
    Checkbox: Container,
    Column: Container,
    Icon: Container,
    Row: Container,
    Switch,
    Text
  };
});

vi.mock('@/ui/components/Popover', () => ({ Popover: () => null }));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const flush = () => act(async () => undefined);

describe('EnableSignDataCard', () => {
  const wallet = { getEnableSignData: vi.fn(), setEnableSignData: vi.fn() };
  const tools = { toastError: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useTools).mockReturnValue(tools as any);
    vi.mocked(useWallet).mockReturnValue(wallet as any);
    wallet.getEnableSignData.mockResolvedValue(true);
  });

  it('keeps sign-data on and shows the error when turning it off cannot be saved', async () => {
    wallet.setEnableSignData.mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'));
    render(<EnableSignDataCard />);
    await flush();

    fireEvent.click(screen.getByTestId('sign-data-switch'));
    await flush();

    expect(wallet.setEnableSignData).toHaveBeenCalledWith(false);
    expect(tools.toastError).toHaveBeenCalledWith('QUOTA_BYTES quota exceeded');
    expect(screen.getByTestId('sign-data-switch').getAttribute('data-checked')).toBe('true');
  });

  it('says the stored setting may have changed when the previous value could not be saved again', async () => {
    // Errors reach the page over the port as plain objects.
    wallet.setEnableSignData.mockRejectedValue({
      message: 'Failed to save enableSignData, and its previous value could not be saved again',
      code: ErrorCodes.PREFERENCE_NOT_RESTORED
    });
    render(<EnableSignDataCard />);
    await flush();

    fireEvent.click(screen.getByTestId('sign-data-switch'));
    await flush();

    expect(tools.toastError).toHaveBeenCalledTimes(1);
    expect(tools.toastError).toHaveBeenCalledWith('setting_not_saved_may_have_changed');
    expect(screen.getByTestId('sign-data-switch').getAttribute('data-checked')).toBe('true');
  });

  it('turns sign-data off once the change is saved', async () => {
    wallet.setEnableSignData.mockResolvedValue(undefined);
    render(<EnableSignDataCard />);
    await flush();

    fireEvent.click(screen.getByTestId('sign-data-switch'));
    await flush();

    expect(tools.toastError).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-data-switch').getAttribute('data-checked')).toBe('false');
  });
});
