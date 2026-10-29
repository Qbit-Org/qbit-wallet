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

/** The decoded PSBT fields a signer's request has always carried, in the order the review returns them. */
const SIGNER_FIELDS = {
  inputInfos: [
    { txid: 'ab'.repeat(32), vout: 0, sequence: 4294967293, address: 'qbrt1zaccount', value: 10_000, sighashType: 0 }
  ],
  outputInfos: [
    { address: 'qbrt1zpayee', value: 2_000, scriptPubKeyHex: '5220beef' },
    { address: 'qbrt1zaccount', value: 4_140, scriptPubKeyHex: '5220cafe' }
  ],
  feeRate: 1,
  fee: 3860,
  features: { rbf: true },
  risks: [HIGH_FEE],
  isScammer: false,
  recommendedFeeRate: 9,
  shouldWarnFeeRate: true,
  isCompleted: true
};

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

  it('sends the signer only the fields it reads, in the order it always had them', async () => {
    // Everything a review returns: the signer's fields, then what only the
    // approval shows, including a field the signer has never seen.
    wallet.decodePsbt.mockImplementation(async () => ({
      ...SIGNER_FIELDS,
      spendSummary: { account: 'qbrt1zaccount' },
      outputOwners: ['none', 'change'],
      version: 2,
      locktime: 900000,
      approvalOnlyDetail: 'never for the signer'
    }));
    render(<ColdWalletSignPsbt psbtHex="70736274ff" suppliedByWebsite onSuccess={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(encoded.requests).toHaveLength(2));
    for (const request of encoded.requests) {
      const { decodedPsbt } = JSON.parse(request);
      expect(JSON.stringify(decodedPsbt)).toBe(JSON.stringify(SIGNER_FIELDS));
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
