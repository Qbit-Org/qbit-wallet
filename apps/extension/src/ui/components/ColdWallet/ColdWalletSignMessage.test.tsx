import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWallet } from '@qbit/wallet-state';
import { cleanup, render, screen } from '@testing-library/react';

import ColdWalletSignMessage from './ColdWalletSignMessage';

vi.mock('qrcode.react', () => ({ default: () => null }));
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  return { Button: () => null, Card: Container, Column: Container, Row: Container, Spin: () => null, Text };
});
vi.mock('@/shared/animatedQr', () => ({
  createMessageDecoder: () => ({ addPart: vi.fn() }),
  encodeSignRequest: vi.fn(),
  getSignTypeDisplayName: (type: string) => type,
  normalizeSignType: (type: string) => type
}));
vi.mock('../MultiQRDisplay', () => ({ default: () => null }));
vi.mock('./Scan', () => ({ default: () => null }));
vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  useWallet: vi.fn()
}));

const messages = [{ text: 'sign me', type: 'ecdsa' }];

describe('ColdWalletSignMessage origin', () => {
  const wallet = { getApproval: vi.fn(), getCurrentAccount: vi.fn() };

  beforeEach(() => {
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the origin of the request being signed, not that of the pending approval', () => {
    wallet.getApproval.mockResolvedValue({
      id: 'replacement-approval-id',
      data: { params: { session: { origin: 'https://replacement.test' } } }
    });
    render(
      <ColdWalletSignMessage messages={messages} onSuccess={vi.fn()} onCancel={vi.fn()} origin="https://signed.test" />
    );

    expect(screen.getByText('https://signed.test')).toBeTruthy();
    expect(screen.queryByText('https://replacement.test')).toBeNull();
    expect(wallet.getApproval).not.toHaveBeenCalled();
  });
});
