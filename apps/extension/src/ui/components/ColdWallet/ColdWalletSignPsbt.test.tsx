import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWallet } from '@qbit/wallet-state';
import { cleanup, render, waitFor } from '@testing-library/react';

import ColdWalletSignPsbt from './ColdWalletSignPsbt';

const encoded = vi.hoisted(() => ({ requests: [] as string[] }));

vi.mock('qrcode.react', () => ({ default: () => null }));
vi.mock('lucide-react', () => ({ LoaderCircle: () => null }));
vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  return { Button: () => null, Card: Container, Column: Container, Icon: Container, Row: Container, Text };
});
vi.mock('@/ui/theme/colors', () => ({ colors: {} }));
vi.mock('@/shared/animatedQr', () => ({
  BBQREncoder: class {
    encode(data: string) {
      encoded.requests.push(data);
      return ['part'];
    }
  }
}));
vi.mock('./Scan', () => ({ default: () => null }));
vi.mock('@qbit/wallet-state', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  useWallet: vi.fn()
}));

const HIGH_FEE = { type: 4, level: 'warning', title: 'High fee detected', desc: '' };

describe('ColdWalletSignPsbt request', () => {
  const wallet = {
    getCurrentAccount: vi.fn(),
    decodePsbt: vi.fn(),
    getNetworkType: vi.fn(),
    getChainType: vi.fn()
  };

  beforeEach(() => {
    encoded.requests = [];
    vi.clearAllMocks();
    wallet.getCurrentAccount.mockResolvedValue({ address: 'qbrt1zaccount', pubkey: 'aa' });
    wallet.getNetworkType.mockResolvedValue(2);
    wallet.getChainType.mockResolvedValue('QBIT_REGTEST');
    wallet.decodePsbt.mockImplementation(async (_psbtHex, _website, options) => ({
      risks: options?.suppliedByWebsite ? [HIGH_FEE] : [],
      spendSummary: { account: 'qbrt1zaccount' }
    }));
    vi.mocked(useWallet).mockReturnValue(wallet as unknown as ReturnType<typeof useWallet>);
  });

  afterEach(() => {
    cleanup();
  });

  it("reviews a website's PSBT as the approval did, so the signer sees its risk", async () => {
    render(<ColdWalletSignPsbt psbtHex="70736274ff" suppliedByWebsite onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(encoded.requests).toHaveLength(2));
    // Its own request and the QR display's.
    expect(wallet.decodePsbt.mock.calls).toEqual([
      ['70736274ff', '', { suppliedByWebsite: true }],
      ['70736274ff', '', { suppliedByWebsite: true }]
    ]);
    for (const request of encoded.requests) {
      const { decodedPsbt } = JSON.parse(request);
      expect(decodedPsbt).toEqual({ risks: [HIGH_FEE] });
    }
  });

  it('keeps what only the approval shows out of the signer’s request', async () => {
    // The approval's display fields: the request the signer reads is unchanged.
    wallet.decodePsbt.mockImplementation(async () => ({
      risks: [HIGH_FEE],
      fee: 3860,
      spendSummary: { account: 'qbrt1zaccount' },
      outputOwners: ['none', 'change'],
      version: 2,
      locktime: 900000
    }));
    render(<ColdWalletSignPsbt psbtHex="70736274ff" suppliedByWebsite onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(encoded.requests).toHaveLength(2));
    for (const request of encoded.requests) {
      const { decodedPsbt } = JSON.parse(request);
      expect(decodedPsbt).toEqual({ risks: [HIGH_FEE], fee: 3860 });
    }
  });

  it('reviews a PSBT the wallet built as its own', async () => {
    render(<ColdWalletSignPsbt psbtHex="70736274ff" onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(encoded.requests).toHaveLength(2));
    expect(wallet.decodePsbt.mock.calls).toEqual([
      ['70736274ff', '', { suppliedByWebsite: false }],
      ['70736274ff', '', { suppliedByWebsite: false }]
    ]);
  });
});
