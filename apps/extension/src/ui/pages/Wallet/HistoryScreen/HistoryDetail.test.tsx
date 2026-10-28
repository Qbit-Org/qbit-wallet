import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useChain, useI18n, useNavigation, useTools, useTxExplorerUrl, useWallet } from '@qbit/wallet-state';

import type { HistoryItem } from './index';
import { HistoryDetail } from './HistoryDetail';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    'data-testid'?: string;
  }) => React.createElement('div', { style, 'data-testid': dataTestId }, children);
  const Button = ({
    text,
    disabled,
    onClick,
    ...props
  }: {
    text?: string;
    disabled?: boolean;
    onClick?: () => void;
    [key: string]: unknown;
  }) => React.createElement('button', { disabled, onClick, ...props }, text);
  const Header = ({ title }: { title?: string }) => React.createElement('div', null, title);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string | number; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);

  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Header,
    Icon: Container,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/CopyableAddress', () => ({
  CopyableAddress: ({ address }: { address: string }) => <span>{address}</span>
}));

vi.mock('@/ui/pages/Wallet/HistoryScreen/index', () => ({
  AmountItem: () => null
}));

vi.mock('@/ui/utils', () => ({
  satoshisToQbit: (satoshis: number) => satoshis / 1e8
}));

vi.mock('@qbit/wallet-state', () => ({
  useChain: vi.fn(),
  useI18n: vi.fn(),
  useNavigation: vi.fn(),
  useTools: vi.fn(),
  useTxExplorerUrl: vi.fn(),
  useWallet: vi.fn()
}));

function historyDetail(overrides: Partial<HistoryItem> = {}): HistoryItem {
  const txid = overrides.txid ?? 'aa'.repeat(32);
  return {
    txid,
    address: 'qbrt1zrecipient',
    type: 'send',
    qbitAmount: -0.0001,
    extra: [],
    confirmations: 0,
    replaceable: false,
    replaced: false,
    feeRate: 1,
    fee: 4_000,
    size: 4_000,
    outputValue: 10_000,
    timestamp: 1_700_000_000_000,
    transaction: {
      txid,
      confirmations: 0,
      height: 0,
      timestamp: 1_700_000_000,
      size: 4_000,
      feeRate: 1,
      fee: 4_000,
      outputValue: 10_000,
      vin: [
        {
          index: 0,
          address: 'qbrt1zwalletinput',
          value: 14_000,
          scriptPubKey: '5120abcd',
          scriptType: 'v1_p2tr',
          owned: true,
          prevTxid: '10'.repeat(32),
          prevVout: 2
        },
        {
          index: 1,
          owned: false,
          prevoutMissing: true
        },
        {
          index: 2,
          owned: false,
          coinbase: true
        }
      ],
      vout: [
        {
          index: 0,
          address: 'qbrt1zrecipient',
          value: 8_000,
          scriptPubKey: '5120cdef',
          scriptType: 'v1_p2tr',
          owned: false
        },
        {
          index: 1,
          address: 'qbrt1zwalletchange',
          value: 2_000,
          scriptPubKey: '5120efab',
          scriptType: 'v1_p2tr',
          owned: true,
          change: true
        },
        {
          index: 2,
          value: 0,
          scriptPubKey: '6a026869',
          scriptType: 'op_return',
          owned: false
        }
      ],
      types: [],
      methods: [],
      direction: 'send',
      amount: 8_000,
      netAmount: -12_000,
      ownedInputValue: 14_000,
      ownedOutputValue: 2_000,
      counterparties: ['qbrt1zrecipient']
    },
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('HistoryDetail qbit fee bump action', () => {
  const navigate = vi.fn();
  const toastError = vi.fn();
  const copyToClipboard = vi.fn();
  const wallet = {
    createBumpFeeQbitPsbt: vi.fn(),
    getQbitFeeBumpEligibility: vi.fn(),
    getQbitRawTransactionHex: vi.fn()
  };

  beforeEach(() => {
    cleanup();
    vi.resetAllMocks();
    vi.mocked(useChain).mockReturnValue({ unit: 'QBIT' } as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useNavigation).mockReturnValue({ navigate } as any);
    vi.mocked(useTools).mockReturnValue({ copyToClipboard, openUrl: vi.fn(), toastError } as any);
    vi.mocked(useTxExplorerUrl).mockReturnValue('');
    vi.mocked(useWallet).mockReturnValue(wallet as any);
    wallet.getQbitFeeBumpEligibility.mockResolvedValue({ eligible: false, reason: 'non_replaceable' });
    wallet.getQbitRawTransactionHex.mockReturnValue(new Promise(() => undefined));
  });

  it('renders every input and output without inventing missing addresses or previous outputs', async () => {
    wallet.getQbitRawTransactionHex.mockResolvedValue('02000000000100');
    render(<HistoryDetail detail={historyDetail()} close={vi.fn()} />);

    expect(screen.getByTestId('history-detail-input-0').textContent).toContain('input_number 1');
    expect(screen.getByTestId('history-detail-input-0').textContent).toContain('qbrt1zwalletinput');
    expect(screen.getByTestId('history-detail-input-0').textContent).toContain('wallet_owned');
    expect(screen.getByTestId('history-detail-input-0').textContent).toContain(`${'10'.repeat(32)}:2`);
    expect(screen.getByTestId('history-detail-input-1').textContent).toContain('previous_output_unavailable');
    expect(screen.getByTestId('history-detail-input-1').textContent).toContain('address_unavailable');
    expect(screen.getByTestId('history-detail-input-1').textContent).toContain('value_unavailable');
    expect(screen.getByTestId('history-detail-input-2').textContent).toContain('coinbase_input');

    expect(screen.getByTestId('history-detail-output-0').textContent).toContain('qbrt1zrecipient');
    expect(screen.getByTestId('history-detail-output-1').textContent).toContain('wallet_owned');
    expect(screen.getByTestId('history-detail-output-1').textContent).toContain('change_output');
    expect(screen.getByTestId('history-detail-output-2').textContent).toContain('address_unavailable');
    expect(screen.getByTestId('history-detail-output-2').textContent).toContain('op_return');

    await waitFor(() => expect(screen.queryByTestId('history-detail-raw-hex-preview')).not.toBeNull());
  });

  it('labels an owned self-transfer output as internal without inventing a counterparty', () => {
    const detail = historyDetail({ address: undefined, qbitAmount: 0.00008, type: 'self' });
    detail.transaction.direction = 'self';
    detail.transaction.vout[1].change = false;
    detail.transaction.vout[1].internal = true;

    render(<HistoryDetail detail={detail} close={vi.fn()} />);

    expect(screen.getByTestId('history-detail-output-1').textContent).toContain('wallet_owned');
    expect(screen.getByTestId('history-detail-output-1').textContent).toContain('internal_output');
    expect(screen.getByText('within_your_account')).toBeTruthy();
  });

  it('labels mixed funding neutrally without describing an external input as a recipient', () => {
    const externalParticipant = 'qbrt1zexternalparticipant';
    const detail = historyDetail({
      address: externalParticipant,
      qbitAmount: -0.00000005,
      type: 'self'
    });
    detail.transaction.vin = [
      {
        index: 0,
        address: 'qbrt1zwalletinput',
        value: 50_000,
        owned: true
      },
      {
        index: 1,
        address: externalParticipant,
        value: 5,
        owned: false
      }
    ];
    detail.transaction.vout = [
      {
        index: 0,
        address: 'qbrt1zwalletoutput',
        value: 49_995,
        owned: true
      }
    ];

    render(<HistoryDetail detail={detail} close={vi.fn()} />);

    expect(screen.getByText('mixed')).toBeTruthy();
    expect(screen.getAllByText(externalParticipant).length).toBeGreaterThan(0);
    expect(screen.queryByText('send_to')).toBeNull();
    expect(screen.queryByText('received_from')).toBeNull();
    expect(screen.queryByText('self_transfer')).toBeNull();
    expect(screen.queryByText('within_your_account')).toBeNull();
    expect(wallet.getQbitFeeBumpEligibility).not.toHaveBeenCalled();
  });

  it('loads a witness-bearing raw transaction and copies the exact API bytes rather than the preview', async () => {
    const rawHex = `020000000001${'ab'.repeat(150)}`;
    wallet.getQbitRawTransactionHex.mockResolvedValue(rawHex);

    render(<HistoryDetail detail={historyDetail()} close={vi.fn()} />);

    expect(screen.getByTestId('raw-transaction-loading').textContent).toContain('loading');
    const preview = await screen.findByTestId('history-detail-raw-hex-preview');
    expect(preview.textContent).toHaveLength(193);
    expect(preview.textContent?.endsWith('…')).toBe(true);
    expect(preview.textContent).not.toContain(rawHex);

    fireEvent.click(screen.getByTestId('copy-raw-transaction'));
    expect(copyToClipboard).toHaveBeenCalledOnce();
    expect(copyToClipboard).toHaveBeenCalledWith(rawHex);
  });

  it('shows an honest raw-transaction error and retries on demand', async () => {
    wallet.getQbitRawTransactionHex
      .mockRejectedValueOnce(new Error('hex endpoint unavailable'))
      .mockResolvedValueOnce('02000000000102');

    render(<HistoryDetail detail={historyDetail()} close={vi.fn()} />);

    expect((await screen.findByTestId('raw-transaction-error')).textContent).toContain('raw_transaction_load_error');
    fireEvent.click(screen.getByTestId('retry-raw-transaction'));

    expect((await screen.findByTestId('history-detail-raw-hex-preview')).textContent).toContain('02000000000102');
    expect(wallet.getQbitRawTransactionHex).toHaveBeenCalledTimes(2);
  });

  it('ignores a raw transaction response after the selected transaction changes', async () => {
    const firstTxid = '11'.repeat(32);
    const secondTxid = '22'.repeat(32);
    const firstRaw = deferred<string>();
    wallet.getQbitRawTransactionHex.mockImplementation((txid: string) =>
      txid === firstTxid ? firstRaw.promise : Promise.resolve('02000000000122')
    );
    const { rerender } = render(<HistoryDetail detail={historyDetail({ txid: firstTxid })} close={vi.fn()} />);

    rerender(<HistoryDetail detail={historyDetail({ txid: secondTxid })} close={vi.fn()} />);
    expect((await screen.findByTestId('history-detail-raw-hex-preview')).textContent).toContain('02000000000122');
    await act(async () => firstRaw.resolve('02000000000111'));

    expect(screen.getByTestId('history-detail-raw-hex-preview').textContent).toContain('02000000000122');
    expect(screen.getByTestId('history-detail-raw-hex-preview').textContent).not.toContain('02000000000111');
  });

  it('ignores a raw transaction response after unmount', async () => {
    const pendingRaw = deferred<string>();
    wallet.getQbitRawTransactionHex.mockReturnValue(pendingRaw.promise);
    const { unmount } = render(<HistoryDetail detail={historyDetail()} close={vi.fn()} />);

    unmount();
    await act(async () => pendingRaw.resolve('02000000000100'));

    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('uses a live controller check instead of the cached replaceable flag and opens truthful review data', async () => {
    const pendingReplacement = deferred<Record<string, unknown>>();
    wallet.getQbitFeeBumpEligibility.mockResolvedValue({ eligible: true });
    wallet.createBumpFeeQbitPsbt.mockReturnValue(pendingReplacement.promise);

    render(<HistoryDetail detail={historyDetail({ replaceable: false })} close={vi.fn()} />);

    const button = await screen.findByTestId('bump-fee-button');
    expect(wallet.getQbitFeeBumpEligibility).toHaveBeenCalledWith('aa'.repeat(32));

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toHaveProperty('disabled', true);
    expect(wallet.createBumpFeeQbitPsbt).toHaveBeenCalledTimes(1);

    const toSignData = { psbtHex: 'replacement-psbt', feeBump: { feeDelta: 5_000 } };
    await act(async () => pendingReplacement.resolve(toSignData));
    expect(navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData });
  });

  it('probes an unconfirmed non-replaced self transfer and exposes an eligible fee bump', async () => {
    const detail = historyDetail({ confirmations: 0, replaced: false, type: 'self' });
    detail.transaction.direction = 'self';
    wallet.getQbitFeeBumpEligibility.mockResolvedValue({ eligible: true });

    render(<HistoryDetail detail={detail} close={vi.fn()} />);

    expect(await screen.findByTestId('bump-fee-button')).toBeTruthy();
    expect(wallet.getQbitFeeBumpEligibility).toHaveBeenCalledWith(detail.txid);
  });

  it.each(['non_replaceable', 'gone', 'unverifiable'] as const)(
    'does not expose the action when the live transaction is %s',
    async (reason) => {
      wallet.getQbitFeeBumpEligibility.mockResolvedValue({ eligible: false, reason });

      render(<HistoryDetail detail={historyDetail({ replaceable: true })} close={vi.fn()} />);

      await waitFor(() => expect(wallet.getQbitFeeBumpEligibility).toHaveBeenCalledOnce());
      expect(screen.queryByTestId('bump-fee-button')).toBeNull();
    }
  );

  it.each([
    ['confirmed', { confirmations: 2 }],
    ['replaced', { confirmations: 0, replaced: true }]
  ] as const)('does not probe or expose the action for a %s history item', (_label, overrides) => {
    render(<HistoryDetail detail={historyDetail(overrides)} close={vi.fn()} />);

    expect(wallet.getQbitFeeBumpEligibility).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bump-fee-button')).toBeNull();
  });

  it('ignores an eligibility response for a transaction that is no longer open', async () => {
    const firstCheck = deferred<{ eligible: true }>();
    wallet.getQbitFeeBumpEligibility
      .mockReturnValueOnce(firstCheck.promise)
      .mockResolvedValueOnce({ eligible: false, reason: 'gone' });
    const { rerender } = render(<HistoryDetail detail={historyDetail({ txid: '11'.repeat(32) })} close={vi.fn()} />);

    rerender(<HistoryDetail detail={historyDetail({ txid: '22'.repeat(32) })} close={vi.fn()} />);
    await waitFor(() => expect(wallet.getQbitFeeBumpEligibility).toHaveBeenCalledTimes(2));
    await act(async () => firstCheck.resolve({ eligible: true }));

    expect(screen.queryByTestId('bump-fee-button')).toBeNull();
  });

  it('ignores stale fee-bump preparation after switching transactions', async () => {
    const firstTxid = '11'.repeat(32);
    const secondTxid = '22'.repeat(32);
    const firstReplacement = deferred<Record<string, unknown>>();
    const secondReplacement = deferred<Record<string, unknown>>();
    wallet.getQbitFeeBumpEligibility.mockResolvedValue({ eligible: true });
    wallet.createBumpFeeQbitPsbt
      .mockReturnValueOnce(firstReplacement.promise)
      .mockReturnValueOnce(secondReplacement.promise);
    const { rerender } = render(<HistoryDetail detail={historyDetail({ txid: firstTxid })} close={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('bump-fee-button'));
    rerender(<HistoryDetail detail={historyDetail({ txid: secondTxid })} close={vi.fn()} />);
    await waitFor(() => expect(wallet.getQbitFeeBumpEligibility).toHaveBeenLastCalledWith(secondTxid));
    const secondButton = await screen.findByTestId('bump-fee-button');
    fireEvent.click(secondButton);
    expect(secondButton).toHaveProperty('disabled', true);

    await act(async () => firstReplacement.reject(new Error('first transaction confirmed')));

    expect(navigate).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(secondButton).toHaveProperty('disabled', true);

    const toSignData = { psbtHex: 'second-replacement-psbt' };
    await act(async () => secondReplacement.resolve(toSignData));
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData });
  });

  it('does not navigate when fee-bump preparation finishes after unmount', async () => {
    const pendingReplacement = deferred<Record<string, unknown>>();
    wallet.getQbitFeeBumpEligibility.mockResolvedValue({ eligible: true });
    wallet.createBumpFeeQbitPsbt.mockReturnValue(pendingReplacement.promise);
    const { unmount } = render(<HistoryDetail detail={historyDetail()} close={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('bump-fee-button'));
    unmount();
    await act(async () => pendingReplacement.resolve({ psbtHex: 'stale-replacement-psbt' }));

    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps replacement-preparation failures on the detail screen with a localized error', async () => {
    wallet.getQbitFeeBumpEligibility.mockResolvedValue({ eligible: true });
    wallet.createBumpFeeQbitPsbt.mockRejectedValue(new Error('transaction confirmed'));

    render(<HistoryDetail detail={historyDetail()} close={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('bump-fee-button'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('fee_bump_unavailable'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
