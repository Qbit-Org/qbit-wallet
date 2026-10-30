import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  useAccountAddress,
  useHistory,
  useHistoryAutoRefresh,
  useHistoryScopeKey,
  useI18n,
  useQbitUnit,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import HistoryScreen from './index';

const ADDRESS = 'qbrt1zself';

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const { Row } = await import('@/ui/components/Row');
  const Container = ({ children, style }: { children?: ReactNode; style?: CSSProperties }) =>
    React.createElement('div', { style }, children);
  const Text = ({ text }: { text?: string | number }) => React.createElement('span', null, text);
  const Header = ({ title }: { title?: string }) => React.createElement('div', null, title);
  const Button = ({ text, onClick, ...props }: { text?: string; onClick?: () => void; [key: string]: unknown }) =>
    React.createElement('button', { onClick, ...props }, text);

  return {
    Button,
    Column: Container,
    Content: Container,
    Header,
    Icon: Container,
    Layout: Container,
    Row,
    Text
  };
});

vi.mock('@/ui/components/Pagination', () => ({
  Pagination: ({
    pagination,
    total,
    onChange
  }: {
    pagination: { currentPage: number; pageSize: number };
    total: number;
    onChange: (pagination: { currentPage: number; pageSize: number }) => void;
  }) => (
    <>
      <span data-testid="pagination-page-count">{Math.ceil(total / pagination.pageSize)}</span>
      <span data-testid="pagination-current-page">{pagination.currentPage}</span>
      <button
        data-testid="pagination-next"
        onClick={() => onChange({ currentPage: pagination.currentPage + 1, pageSize: pagination.pageSize })}
      />
      <button
        data-testid="pagination-page-three"
        onClick={() => onChange({ currentPage: 3, pageSize: pagination.pageSize })}
      />
    </>
  )
}));

vi.mock('@/ui/pages/Wallet/HistoryScreen/HistoryDetail', () => ({
  HistoryDetail: () => null
}));

vi.mock('@/ui/utils', () => ({
  satoshisToQbit: (satoshis: number) => satoshis / 1e8,
  shortAddress: (address?: string) => address ?? ''
}));

vi.mock('@qbit/wallet-state', () => ({
  useAccountAddress: vi.fn(),
  useHistory: vi.fn(),
  useHistoryAutoRefresh: vi.fn(),
  useHistoryScopeKey: vi.fn(),
  useI18n: vi.fn(),
  useQbitUnit: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

function historyItem(overrides: Record<string, unknown>) {
  return {
    txid: 'tx',
    confirmations: 0,
    height: 0,
    timestamp: 1_700_000_000,
    size: 200,
    feeRate: 1,
    fee: 200,
    outputValue: 10_000,
    vin: [{ index: 0, address: 'qbrt1zother', value: 10_000, owned: false }],
    vout: [{ index: 0, address: ADDRESS, value: 10_000, owned: true }],
    types: [],
    methods: [],
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('HistoryScreen lifecycle badges', () => {
  const refreshHistory = vi.fn();

  beforeEach(() => {
    cleanup();
    vi.resetAllMocks();
    vi.mocked(useAccountAddress).mockReturnValue(ADDRESS);
    refreshHistory.mockResolvedValue(undefined);
    vi.mocked(useHistoryAutoRefresh).mockReturnValue(refreshHistory);
    vi.mocked(useHistoryScopeKey).mockReturnValue('qbit-account:regtest:account-one');
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBIT' as any);
    vi.mocked(useTools).mockReturnValue({ showLoading: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({
      getAddressHistory: vi.fn().mockResolvedValue({ start: 0, total: 0, detail: [] })
    } as any);
    vi.mocked(useHistory).mockReturnValue({ list: [], expired: true } as any);
  });

  it('renders pending, replaced and young-confirmation states from the session history', () => {
    vi.mocked(useHistory).mockReturnValue({
      list: [
        historyItem({ txid: 'tx-pending', confirmations: 0, replaceable: true }),
        historyItem({ txid: 'tx-young', confirmations: 3 }),
        historyItem({ txid: 'tx-deep', confirmations: 100 }),
        historyItem({ txid: 'tx-replaced', confirmations: 0, replaced: true })
      ],
      expired: false
    } as any);

    render(<HistoryScreen />);

    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getByText('replaced')).toBeTruthy();
    expect(screen.getByText('3 confirmations_count · ~3 minutes')).toBeTruthy();
    expect(screen.getByTestId('history-item-tx-pending').getAttribute('data-transaction-status')).toBe('Pending');
    expect(screen.getByTestId('history-item-tx-young').getAttribute('data-transaction-status')).toBe('Confirmed');
    expect(screen.getByTestId('history-item-tx-deep').getAttribute('data-transaction-status')).toBe('Confirmed');
    expect(screen.getByTestId('history-item-tx-replaced').getAttribute('data-transaction-status')).toBe('Replaced');
    // Deeply confirmed rows carry no lifecycle line.
    expect(screen.queryByText('100 confirmations_count · ~100 minutes')).toBeNull();
    expect(screen.queryByText('this_account_has_no_transactions')).toBeNull();
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('1');
  });

  it('keeps the empty state and loading lifecycle when there is no history', async () => {
    const showLoading = vi.fn();
    let currentHistory = { list: [], expired: true };
    vi.mocked(useTools).mockReturnValue({ showLoading } as any);
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);

    const { rerender } = render(<HistoryScreen />);

    expect(screen.getByText('this_account_has_no_transactions')).toBeTruthy();
    expect(screen.queryByText('pending')).toBeNull();
    expect(screen.queryByText('replaced')).toBeNull();
    expect(showLoading).toHaveBeenCalledWith(true);
    currentHistory = { list: [], expired: false };
    rerender(<HistoryScreen />);
    await waitFor(() => expect(showLoading).toHaveBeenLastCalledWith(false));
  });

  it('shows an honest empty-state error and retries through the lifecycle refresh callback', () => {
    vi.mocked(useHistory).mockReturnValue({
      list: [],
      expired: false,
      error: true
    } as unknown as ReturnType<typeof useHistory>);

    render(<HistoryScreen />);

    expect(screen.getByText('history_load_error')).toBeTruthy();
    fireEvent.click(screen.getByTestId('history-retry-button'));
    expect(refreshHistory).toHaveBeenCalledOnce();
  });

  it('renders self transfers without a misleading counterparty or signed amount', () => {
    vi.mocked(useHistory).mockReturnValue({
      list: [
        historyItem({
          txid: 'tx-self',
          direction: 'self',
          amount: 8_000,
          netAmount: -200,
          counterparties: [],
          vin: [{ index: 0, address: ADDRESS, value: 10_000, owned: true }],
          vout: [
            {
              index: 0,
              address: 'qbrt1zownedtwo',
              value: 8_000,
              owned: true,
              internal: true
            }
          ]
        })
      ],
      total: 1,
      expired: false
    } as unknown as ReturnType<typeof useHistory>);

    render(<HistoryScreen />);

    expect(screen.getByText('self_transfer')).toBeTruthy();
    expect(screen.getByText('within_your_account')).toBeTruthy();
    expect(screen.queryByText('+')).toBeNull();
    expect(screen.queryByText('-')).toBeNull();
    expect(screen.getByTestId('history-icon-self')).toBeTruthy();
    expect(screen.queryByTestId('history-icon-send')).toBeNull();
    expect(screen.queryByTestId('history-icon-receive')).toBeNull();
  });

  it('renders mixed funding with a neutral participant label instead of self or send-to copy', () => {
    const externalParticipant = 'qbrt1zexternalparticipant';
    vi.mocked(useHistory).mockReturnValue({
      list: [
        historyItem({
          txid: 'tx-mixed-negative',
          direction: 'self',
          amount: 49_995,
          netAmount: -5,
          counterparties: [ADDRESS],
          vin: [
            { index: 0, address: ADDRESS, value: 50_000, owned: true },
            { index: 1, address: externalParticipant, value: 5, owned: false }
          ],
          vout: [{ index: 0, address: ADDRESS, value: 49_995, owned: true }]
        })
      ],
      total: 1,
      expired: false
    } as unknown as ReturnType<typeof useHistory>);

    render(<HistoryScreen />);

    expect(screen.getByText('mixed')).toBeTruthy();
    expect(screen.getByText(externalParticipant)).toBeTruthy();
    expect(screen.getByText('-')).toBeTruthy();
    expect(screen.queryByText('send')).toBeNull();
    expect(screen.queryByText(`to ${externalParticipant}`)).toBeNull();
    expect(screen.queryByText('self_transfer')).toBeNull();
    expect(screen.queryByText('within_your_account')).toBeNull();
  });

  it('does not show a directional sign for zero-net mixed funding', () => {
    vi.mocked(useHistory).mockReturnValue({
      list: [
        historyItem({
          txid: 'tx-mixed-zero',
          direction: 'self',
          amount: 50_000,
          netAmount: 0,
          counterparties: [ADDRESS],
          vin: [
            { index: 0, address: ADDRESS, value: 50_000, owned: true },
            {
              index: 1,
              address: 'qbrt1zexternalparticipant',
              value: 10,
              owned: false
            }
          ],
          vout: [{ index: 0, address: ADDRESS, value: 50_000, owned: true }]
        })
      ],
      total: 1,
      expired: false
    } as unknown as ReturnType<typeof useHistory>);

    render(<HistoryScreen />);

    expect(screen.getByText('mixed')).toBeTruthy();
    expect(screen.queryByText('+')).toBeNull();
    expect(screen.queryByText('-')).toBeNull();
  });

  it('renders nonempty session history without duplicating the auto-refresh request', () => {
    const showLoading = vi.fn();
    const getAddressHistory = vi.fn().mockResolvedValue({ start: 0, total: 1, detail: [] });
    vi.mocked(useTools).mockReturnValue({ showLoading } as any);
    vi.mocked(useHistory).mockReturnValue({
      list: [historyItem({ txid: 'tx-cached' })],
      expired: false
    } as any);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as any);

    render(<HistoryScreen />);

    expect(getAddressHistory).not.toHaveBeenCalled();
    expect(showLoading).not.toHaveBeenCalled();
    expect(screen.getByText('pending')).toBeTruthy();
  });

  it('keeps cached history and pagination visible with a refresh error and retry', () => {
    const getAddressHistory = vi.fn().mockRejectedValue(new Error('offline'));
    vi.mocked(useHistory).mockReturnValue({
      list: [
        historyItem({
          txid: 'tx-cached',
          vin: [{ address: 'cached-source', value: 10_000 }]
        })
      ],
      total: 60,
      expired: false,
      error: true
    } as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    render(<HistoryScreen />);

    expect(screen.getByTestId('history-item-tx-cached')).toBeTruthy();
    expect(getAddressHistory).not.toHaveBeenCalled();
    expect(screen.getByText('from cached-source')).toBeTruthy();
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('3');
    expect(screen.getByText('history_load_error')).toBeTruthy();
    expect(screen.getByTestId('history-retry-button').textContent).toBe('try_again');
    fireEvent.click(screen.getByTestId('history-retry-button'));
    expect(refreshHistory).toHaveBeenCalledOnce();
  });

  it('uses the newest coherent page-one total and first-page snapshot', () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    let currentHistory = {
      list: [...firstPage, historyItem({ txid: 'tx-replaced', replaced: true })],
      total: 20,
      expired: false,
      firstPageTxids: undefined as string[] | undefined,
      verifiedPendingTxids: [] as string[]
    };
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);

    const { rerender } = render(<HistoryScreen />);

    expect(screen.getByTestId('pagination-page-count').textContent).toBe('1');

    currentHistory = {
      list: [...firstPage, historyItem({ txid: 'tx-carried' })],
      total: 41,
      expired: false,
      firstPageTxids: firstPage.map((item) => item.txid),
      verifiedPendingTxids: ['tx-carried']
    };
    rerender(<HistoryScreen />);
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('3');

    currentHistory = {
      list: firstPage.slice(0, 19),
      total: 19,
      expired: false,
      firstPageTxids: firstPage.slice(0, 19).map((item) => item.txid),
      verifiedPendingTxids: []
    };
    rerender(<HistoryScreen />);
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('1');
  });

  it('does not discount retained pending rows whose lifecycle probes failed', () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const getAddressHistory = vi.fn().mockReturnValue(new Promise(() => undefined));
    vi.mocked(useHistory).mockReturnValue({
      list: [...firstPage, historyItem({ txid: 'tx-probe-failed-1' }), historyItem({ txid: 'tx-probe-failed-2' })],
      total: 21,
      expired: false,
      firstPageTxids: firstPage.map((item) => item.txid),
      verifiedPendingTxids: []
    } as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    render(<HistoryScreen />);

    expect(getAddressHistory).not.toHaveBeenCalled();
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('2');
  });

  it('keeps a lifecycle-verified carried pending row out of the omitted count when absent from the snapshot', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const secondPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-second-${index}`,
        vin: [{ address: `second-source-${index}`, value: 10_000 }]
      })
    );
    const snapshotTail = historyItem({
      txid: 'tx-snapshot-tail',
      vin: [{ address: 'snapshot-tail-source', value: 10_000 }]
    });
    const carriedPending = historyItem({ txid: 'tx-carried-after-snapshot' });
    const getAddressHistory = vi.fn().mockImplementation(({ start }: { start: number }) =>
      Promise.resolve({
        start,
        total: 41,
        detail: start === 20 ? secondPage : [snapshotTail],
        snapshotId: 'snapshot-one'
      })
    );
    vi.mocked(useHistory).mockReturnValue({
      list: [...firstPage, carriedPending],
      total: 41,
      expired: false,
      firstPageTxids: firstPage.map((item) => item.txid),
      snapshotId: 'snapshot-one',
      verifiedPendingTxids: [carriedPending.txid]
    } as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    render(<HistoryScreen />);

    expect(screen.getByTestId('pagination-page-count').textContent).toBe('3');
    fireEvent.click(screen.getByTestId('pagination-page-three'));

    await waitFor(() => expect(screen.getByText('from snapshot-tail-source')).toBeTruthy());
    expect(getAddressHistory).toHaveBeenNthCalledWith(1, {
      address: ADDRESS,
      start: 20,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(getAddressHistory).toHaveBeenNthCalledWith(2, {
      address: ADDRESS,
      start: 40,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(screen.getByTestId('pagination-current-page').textContent).toBe('3');
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('3');
  });

  it('does not show the account-empty message while a later page is loading', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const secondPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-second-${index}`,
        vin: [{ address: `second-source-${index}`, value: 10_000 }]
      })
    );
    const pageFetch = deferred<{
      start: number;
      total: number;
      detail: ReturnType<typeof historyItem>[];
      snapshotId: string;
    }>();
    const showLoading = vi.fn();
    const getAddressHistory = vi.fn().mockReturnValue(pageFetch.promise);
    vi.mocked(useHistory).mockReturnValue({
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    } as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    render(<HistoryScreen />);
    fireEvent.click(screen.getByTestId('pagination-next'));

    expect(getAddressHistory).toHaveBeenCalledWith({
      address: ADDRESS,
      start: 20,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(showLoading).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText('this_account_has_no_transactions')).toBeNull();
    expect(screen.queryByText('history_load_error')).toBeNull();

    await act(async () => {
      pageFetch.resolve({
        start: 20,
        total: 40,
        detail: secondPage,
        snapshotId: 'snapshot-one'
      });
      await pageFetch.promise;
    });

    await waitFor(() => expect(screen.getByText('from second-source-0')).toBeTruthy());
    expect(showLoading).toHaveBeenLastCalledWith(false);
  });

  it('counts and skips verified duplicates after encountering them so later unique history stays reachable', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const carriedPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-carried-${index}`,
        vin: [{ address: `carried-source-${index}`, value: 10_000 }]
      })
    );
    const uniqueTail = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-tail-${index}`,
        vin: [{ address: `tail-source-${index}`, value: 10_000 }]
      })
    );
    const getAddressHistory = vi.fn().mockImplementation(({ start }: { start: number }) => {
      if (start === 0) {
        return Promise.resolve({ start, total: 60, detail: firstPage, snapshotId: 'snapshot-one' });
      }
      if (start === 20) {
        return Promise.resolve({ start, total: 60, detail: carriedPage, snapshotId: 'snapshot-one' });
      }
      return Promise.resolve({ start, total: 60, detail: uniqueTail, snapshotId: 'snapshot-one' });
    });
    vi.mocked(useHistory).mockReturnValue({
      list: [...firstPage, ...carriedPage],
      total: 60,
      expired: false,
      firstPageTxids: firstPage.map((item) => item.txid),
      snapshotId: 'snapshot-one',
      verifiedPendingTxids: carriedPage.map((item) => item.txid)
    } as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    render(<HistoryScreen />);

    expect(getAddressHistory).not.toHaveBeenCalled();
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('3');
    expect(screen.getByText('from carried-source-19')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pagination-next'));

    await waitFor(() => expect(screen.getByText('from tail-source-19')).toBeTruthy());
    expect(screen.queryAllByText(/^from carried-source-/)).toHaveLength(0);
    expect(getAddressHistory).toHaveBeenNthCalledWith(1, {
      address: ADDRESS,
      start: 20,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(getAddressHistory).toHaveBeenNthCalledWith(2, {
      address: ADDRESS,
      start: 40,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('2');
  });

  it('does not scan beyond the requested later page to pre-count a verified duplicate', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const secondPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-second-${index}`,
        vin: [{ address: `second-source-${index}`, value: 10_000 }]
      })
    );
    const carriedTail = historyItem({
      txid: 'tx-carried-tail',
      vin: [{ address: 'carried-tail-source', value: 10_000 }]
    });
    const getAddressHistory = vi.fn().mockImplementation(({ start }: { start: number }) => {
      if (start === 0) {
        return Promise.resolve({ start, total: 41, detail: firstPage, snapshotId: 'snapshot-one' });
      }
      if (start === 20) {
        return Promise.resolve({ start, total: 41, detail: secondPage, snapshotId: 'snapshot-one' });
      }
      return Promise.resolve({ start, total: 41, detail: [carriedTail], snapshotId: 'snapshot-one' });
    });
    vi.mocked(useHistory).mockReturnValue({
      list: [...firstPage, carriedTail],
      total: 41,
      expired: false,
      firstPageTxids: firstPage.map((item) => item.txid),
      snapshotId: 'snapshot-one',
      verifiedPendingTxids: [carriedTail.txid]
    } as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    render(<HistoryScreen />);

    await waitFor(() => expect(screen.getByTestId('pagination-page-count').textContent).toBe('3'));
    fireEvent.click(screen.getByTestId('pagination-next'));

    await waitFor(() => expect(screen.getByText('from second-source-19')).toBeTruthy());
    expect(getAddressHistory).toHaveBeenCalledTimes(1);
    expect(getAddressHistory).not.toHaveBeenCalledWith({
      address: ADDRESS,
      start: 40,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(screen.queryByText('from carried-tail-source')).toBeNull();
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('3');
  });

  it('refetches a later page when the session history refreshes', async () => {
    const showLoading = vi.fn();
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const oldTail = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-old-${index}`,
        vin: [{ address: `old-source-${index}`, value: 10_000 }]
      })
    );
    const newTail = Array.from({ length: 19 }, (_, index) =>
      historyItem({
        txid: `tx-new-${index}`,
        vin: [{ address: `new-source-${index}`, value: 10_000 }]
      })
    );
    let currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    let laterPageFetches = 0;
    const getAddressHistory = vi.fn().mockImplementation(({ start }: { start: number }) => {
      if (start === 0) {
        return Promise.resolve({ start, total: 40, detail: firstPage, snapshotId: 'snapshot-one' });
      }
      laterPageFetches += 1;
      return Promise.resolve({
        start,
        total: 40,
        detail: laterPageFetches === 1 ? oldTail : [oldTail[0], ...newTail],
        snapshotId: 'snapshot-one'
      });
    });
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    expect(getAddressHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('pagination-next'));
    await waitFor(() => expect(screen.getByText('from old-source-0')).toBeTruthy());
    expect(showLoading.mock.calls).toEqual([[true], [false]]);
    showLoading.mockClear();

    currentHistory = {
      list: [...firstPage],
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    rerender(<HistoryScreen />);
    expect(laterPageFetches).toBe(1);
    expect(showLoading).not.toHaveBeenCalled();

    currentHistory = {
      list: [oldTail[0], ...firstPage.slice(0, 19)],
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    rerender(<HistoryScreen />);

    expect(screen.queryByText(/^from old-source-/)).toBeNull();
    expect(showLoading).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByText('from new-source-0')).toBeTruthy());
    expect(screen.queryByText(/^from old-source-/)).toBeNull();
    expect(laterPageFetches).toBe(2);
    expect(showLoading).toHaveBeenLastCalledWith(false);
  });

  it('holds later pages until the session pins a snapshot id', async () => {
    const showLoading = vi.fn();
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const tail = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-tail-${index}`,
        vin: [{ address: `tail-source-${index}`, value: 10_000 }]
      })
    );
    let currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: undefined as string | undefined,
      verifiedPendingTxids: [] as string[],
      error: false
    };
    const getAddressHistory = vi.fn(({ start }: { start: number }) =>
      Promise.resolve({ start, total: 40, detail: tail, snapshotId: 'snapshot-one' })
    );
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    fireEvent.click(screen.getByTestId('pagination-next'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(getAddressHistory).not.toHaveBeenCalled();
    expect(screen.queryByText('history_load_error')).toBeNull();
    expect(showLoading).toHaveBeenLastCalledWith(true);
    showLoading.mockClear();

    currentHistory = { ...currentHistory, snapshotId: 'snapshot-one' };
    rerender(<HistoryScreen />);

    await waitFor(() => expect(screen.getByText('from tail-source-0')).toBeTruthy());
    expect(getAddressHistory).toHaveBeenCalledTimes(1);
    expect(getAddressHistory).toHaveBeenCalledWith({
      address: ADDRESS,
      start: 20,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(showLoading).toHaveBeenLastCalledWith(false);
  });

  it('waits for expired session history before refetching the current later page', async () => {
    const showLoading = vi.fn();
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const refreshedFirstPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({ txid: `tx-refreshed-first-${index}` })
    );
    const oldTail = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-old-${index}`,
        vin: [{ address: `old-source-${index}`, value: 10_000 }]
      })
    );
    const newTail = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-new-${index}`,
        vin: [{ address: `new-source-${index}`, value: 10_000 }]
      })
    );
    let currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one',
      verifiedPendingTxids: [] as string[],
      error: false
    };
    const getAddressHistory = vi.fn(({ start, snapshotId }: { start: number; snapshotId?: string }) =>
      Promise.resolve({
        start,
        total: 40,
        detail: snapshotId === 'snapshot-one' ? oldTail : newTail,
        snapshotId
      })
    );
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    fireEvent.click(screen.getByTestId('pagination-next'));
    await waitFor(() => expect(screen.getByText('from old-source-0')).toBeTruthy());
    expect(getAddressHistory).toHaveBeenCalledTimes(1);
    showLoading.mockClear();

    currentHistory = { ...currentHistory, expired: true };
    rerender(<HistoryScreen />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getAddressHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^from old-source-/)).toBeNull();
    expect(screen.queryByText('history_load_error')).toBeNull();
    expect(showLoading.mock.calls).toEqual([[true]]);

    currentHistory = { ...currentHistory, error: true };
    rerender(<HistoryScreen />);

    await waitFor(() => expect(screen.getByText('history_load_error')).toBeTruthy());
    expect(getAddressHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('history-retry-button')).toBeTruthy();
    expect(showLoading).toHaveBeenLastCalledWith(false);

    currentHistory = {
      list: refreshedFirstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-two',
      verifiedPendingTxids: [],
      error: false
    };
    rerender(<HistoryScreen />);

    await waitFor(() => expect(screen.getByText('from new-source-0')).toBeTruthy());
    expect(getAddressHistory).toHaveBeenCalledTimes(2);
    expect(getAddressHistory).toHaveBeenLastCalledWith({
      address: ADDRESS,
      start: 20,
      limit: 20,
      snapshotId: 'snapshot-two'
    });
    expect(screen.getByTestId('pagination-current-page').textContent).toBe('2');
    expect(screen.queryByText('history_load_error')).toBeNull();
    expect(showLoading).toHaveBeenLastCalledWith(false);
  });

  it('hides a cached later page while refreshed snapshot and omission metadata load', async () => {
    const showLoading = vi.fn();
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const oldTail = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-old-${index}`,
        vin: [{ address: `old-source-${index}`, value: 10_000 }]
      })
    );
    const newTail = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-new-${index}`,
        vin: [{ address: `new-source-${index}`, value: 10_000 }]
      })
    );
    const refreshedPageFetch = deferred<{
      start: number;
      total: number;
      detail: ReturnType<typeof historyItem>[];
      snapshotId: string;
    }>();
    let currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one',
      verifiedPendingTxids: [] as string[]
    };
    const getAddressHistory = vi.fn(({ start, snapshotId }: { start: number; snapshotId?: string }) => {
      if (snapshotId === 'snapshot-one') {
        return Promise.resolve({ start, total: 40, detail: oldTail, snapshotId });
      }
      return refreshedPageFetch.promise;
    });
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    fireEvent.click(screen.getByTestId('pagination-next'));
    await waitFor(() => expect(screen.getByText('from old-source-0')).toBeTruthy());
    showLoading.mockClear();

    currentHistory = {
      ...currentHistory,
      snapshotId: 'snapshot-two',
      verifiedPendingTxids: ['tx-0']
    };
    rerender(<HistoryScreen />);

    await waitFor(() => expect(getAddressHistory).toHaveBeenCalledTimes(2));
    expect(getAddressHistory).toHaveBeenLastCalledWith({
      address: ADDRESS,
      start: 20,
      limit: 20,
      snapshotId: 'snapshot-two'
    });
    expect(screen.queryByText(/^from old-source-/)).toBeNull();
    expect(screen.queryByText('this_account_has_no_transactions')).toBeNull();
    expect(screen.queryByText('history_load_error')).toBeNull();
    expect(showLoading).toHaveBeenLastCalledWith(true);

    await act(async () => {
      refreshedPageFetch.resolve({
        start: 20,
        total: 40,
        detail: newTail,
        snapshotId: 'snapshot-two'
      });
      await refreshedPageFetch.promise;
    });

    await waitFor(() => expect(screen.getByText('from new-source-0')).toBeTruthy());
    expect(showLoading).toHaveBeenLastCalledWith(false);
  });

  it('replaces stale later-page rows with an error and retry when a refresh fails', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const secondPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-second-${index}`,
        vin: [{ address: `second-source-${index}`, value: 10_000 }]
      })
    );
    let currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    const getAddressHistory = vi
      .fn()
      .mockResolvedValueOnce({ start: 20, total: 40, detail: secondPage, snapshotId: 'snapshot-one' })
      .mockRejectedValueOnce(new Error('snapshot expired'));
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    fireEvent.click(screen.getByTestId('pagination-next'));
    await waitFor(() => expect(screen.getByText('from second-source-0')).toBeTruthy());

    currentHistory = {
      ...currentHistory,
      list: [historyItem({ txid: 'tx-refreshed' }), ...firstPage.slice(1)]
    };
    rerender(<HistoryScreen />);

    await waitFor(() => expect(screen.getByText('history_load_error')).toBeTruthy());
    expect(screen.queryByText('from second-source-0')).toBeNull();
    expect(screen.getByTestId('history-retry-button')).toBeTruthy();
  });

  it('refreshes the account-history snapshot before retrying a later page', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const secondPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-second-${index}`,
        vin: [{ address: `second-source-${index}`, value: 10_000 }]
      })
    );
    const refresh = deferred<void>();
    let currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    const getAddressHistory = vi.fn(({ start, snapshotId }: { start: number; snapshotId?: string }) => {
      if (snapshotId === 'snapshot-one') {
        return Promise.reject(new Error('snapshot expired'));
      }
      return Promise.resolve({ start, total: 40, detail: secondPage, snapshotId: 'snapshot-two' });
    });
    refreshHistory.mockReturnValue(refresh.promise);
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    render(<HistoryScreen />);

    fireEvent.click(screen.getByTestId('pagination-next'));
    await waitFor(() => expect(screen.getByText('history_load_error')).toBeTruthy());
    expect(getAddressHistory).toHaveBeenCalledWith({
      address: ADDRESS,
      start: 20,
      limit: 20,
      snapshotId: 'snapshot-one'
    });

    fireEvent.click(screen.getByTestId('history-retry-button'));
    expect(refreshHistory).toHaveBeenCalledOnce();
    expect(getAddressHistory).toHaveBeenCalledTimes(1);

    currentHistory = {
      ...currentHistory,
      snapshotId: 'snapshot-two'
    };
    await act(async () => {
      refresh.resolve(undefined);
      await refresh.promise;
    });

    await waitFor(() =>
      expect(getAddressHistory).toHaveBeenLastCalledWith({
        address: ADDRESS,
        start: 20,
        limit: 20,
        snapshotId: 'snapshot-two'
      })
    );
    expect(getAddressHistory).toHaveBeenCalledTimes(2);
    expect(screen.getByText('from second-source-0')).toBeTruthy();
  });

  it('resets pagination and ignores the previous total when the account changes', async () => {
    const nextAddress = 'qbrt1znext';
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const nextHistory = historyItem({
      txid: 'tx-next-account',
      vin: [{ address: 'next-account-source', value: 10_000 }],
      vout: [{ address: nextAddress, value: 10_000 }]
    });
    const previousFetch = deferred<{
      start: number;
      total: number;
      detail: ReturnType<typeof historyItem>[];
    }>();
    let currentAddress = ADDRESS;
    let currentHistory: {
      list: ReturnType<typeof historyItem>[];
      expired: boolean;
      total: number;
      snapshotId: string;
    } = {
      list: firstPage,
      expired: false,
      total: 60,
      snapshotId: 'snapshot-one'
    };
    const showLoading = vi.fn();
    const getAddressHistory = vi.fn(({ address, start }: { address: string; start: number }) => {
      if (start === 20) {
        return previousFetch.promise;
      }
      return Promise.resolve({ start, total: 60, detail: firstPage, snapshotId: 'snapshot-one' });
    });
    vi.mocked(useAccountAddress).mockImplementation(() => currentAddress);
    vi.mocked(useHistoryScopeKey).mockImplementation(() => currentAddress);
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    await waitFor(() => expect(screen.getByTestId('pagination-page-count').textContent).toBe('3'));
    fireEvent.click(screen.getByTestId('pagination-next'));
    await waitFor(() =>
      expect(getAddressHistory).toHaveBeenCalledWith({
        address: ADDRESS,
        start: 20,
        limit: 20,
        snapshotId: 'snapshot-one'
      })
    );
    expect(showLoading).toHaveBeenLastCalledWith(true);

    const loadingCallCount = showLoading.mock.calls.length;
    currentAddress = nextAddress;
    currentHistory = {
      list: [nextHistory],
      total: 1,
      expired: false,
      snapshotId: 'snapshot-two'
    };
    rerender(<HistoryScreen />);

    expect(screen.getByText('from next-account-source')).toBeTruthy();
    expect(screen.getByTestId('pagination-current-page').textContent).toBe('1');
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('1');
    expect(showLoading).toHaveBeenCalledTimes(loadingCallCount + 1);
    expect(showLoading).toHaveBeenLastCalledWith(false);
    expect(showLoading.mock.calls.filter(([show]) => show).length).toBe(1);
    expect(showLoading.mock.calls.filter(([show]) => !show).length).toBe(1);
  });

  it('does not reuse a cached later page after leaving and returning to a history scope', async () => {
    const nextAddress = 'qbrt1znext';
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const cachedSecondPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-cached-${index}`,
        vin: [{ address: `cached-source-${index}`, value: 10_000 }]
      })
    );
    const refreshedSecondPage = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-refreshed-${index}`,
        vin: [{ address: `refreshed-source-${index}`, value: 10_000 }]
      })
    );
    const nextItem = historyItem({
      txid: 'tx-next',
      vin: [{ address: 'next-source', value: 10_000 }],
      vout: [{ address: nextAddress, value: 10_000 }]
    });
    const returningFetch = deferred<{
      start: number;
      total: number;
      detail: ReturnType<typeof historyItem>[];
      snapshotId: string;
    }>();
    let currentAddress = ADDRESS;
    let currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    let firstScopePageFetches = 0;
    const showLoading = vi.fn();
    const getAddressHistory = vi.fn(({ address, start }: { address: string; start: number }) => {
      if (address === ADDRESS && start === 20) {
        firstScopePageFetches += 1;
        if (firstScopePageFetches === 1) {
          return Promise.resolve({
            start,
            total: 40,
            detail: cachedSecondPage,
            snapshotId: 'snapshot-one'
          });
        }
        return returningFetch.promise;
      }
      return Promise.resolve({ start, total: 1, detail: [nextItem], snapshotId: 'snapshot-two' });
    });
    vi.mocked(useAccountAddress).mockImplementation(() => currentAddress);
    vi.mocked(useHistoryScopeKey).mockImplementation(() => currentAddress);
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    fireEvent.click(screen.getByTestId('pagination-next'));
    await waitFor(() => expect(screen.getByText('from cached-source-0')).toBeTruthy());

    currentAddress = nextAddress;
    currentHistory = {
      list: [nextItem],
      total: 1,
      expired: false,
      snapshotId: 'snapshot-two'
    };
    rerender(<HistoryScreen />);
    expect(screen.getByText('from next-source')).toBeTruthy();

    currentAddress = ADDRESS;
    currentHistory = {
      list: firstPage,
      total: 40,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    rerender(<HistoryScreen />);
    fireEvent.click(screen.getByTestId('pagination-next'));

    await waitFor(() => expect(firstScopePageFetches).toBe(2));
    expect(screen.queryByText('from cached-source-0')).toBeNull();
    expect(showLoading).toHaveBeenLastCalledWith(true);

    await act(async () => {
      returningFetch.resolve({
        start: 20,
        total: 40,
        detail: refreshedSecondPage,
        snapshotId: 'snapshot-one'
      });
      await returningFetch.promise;
    });

    expect(screen.getByText('from refreshed-source-0')).toBeTruthy();
    expect(showLoading).toHaveBeenLastCalledWith(false);
  });

  it('does not let an obsolete multi-chunk fetch overwrite the active account', async () => {
    const nextAddress = 'qbrt1znext';
    const firstPage = Array.from({ length: 20 }, (_, index) => historyItem({ txid: `tx-${index}` }));
    const staleChunk = Array.from({ length: 20 }, (_, index) =>
      historyItem({
        txid: `tx-stale-${index}`,
        vin: [{ address: `stale-source-${index}`, value: 10_000 }]
      })
    );
    const nextItem = historyItem({
      txid: 'tx-next',
      vin: [{ address: 'active-source', value: 10_000 }],
      vout: [{ address: nextAddress, value: 10_000 }]
    });
    const staleFetch = deferred<{
      start: number;
      total: number;
      detail: ReturnType<typeof historyItem>[];
      snapshotId: string;
    }>();
    let currentAddress = ADDRESS;
    let currentHistory = {
      list: firstPage,
      total: 60,
      expired: false,
      snapshotId: 'snapshot-one'
    };
    const showLoading = vi.fn();
    const getAddressHistory = vi.fn(({ address, start }: { address: string; start: number }) => {
      if (start === 20) {
        return staleFetch.promise;
      }
      return Promise.resolve({ start, total: 60, detail: firstPage, snapshotId: 'snapshot-one' });
    });
    vi.mocked(useAccountAddress).mockImplementation(() => currentAddress);
    vi.mocked(useHistoryScopeKey).mockImplementation(() => currentAddress);
    vi.mocked(useHistory).mockImplementation(() => currentHistory as unknown as ReturnType<typeof useHistory>);
    vi.mocked(useTools).mockReturnValue({ showLoading } as unknown as ReturnType<typeof useTools>);
    vi.mocked(useWallet).mockReturnValue({ getAddressHistory } as unknown as ReturnType<typeof useWallet>);

    const { rerender } = render(<HistoryScreen />);

    await waitFor(() => expect(screen.getByTestId('pagination-page-count').textContent).toBe('3'));
    fireEvent.click(screen.getByTestId('pagination-page-three'));
    await waitFor(() =>
      expect(getAddressHistory).toHaveBeenCalledWith({
        address: ADDRESS,
        start: 20,
        limit: 20,
        snapshotId: 'snapshot-one'
      })
    );

    currentAddress = nextAddress;
    currentHistory = {
      list: [nextItem],
      total: 1,
      expired: false,
      snapshotId: 'snapshot-two'
    };
    rerender(<HistoryScreen />);
    expect(screen.getByText('from active-source')).toBeTruthy();
    expect(showLoading).toHaveBeenLastCalledWith(false);

    await act(async () => {
      staleFetch.resolve({ start: 20, total: 60, detail: staleChunk, snapshotId: 'snapshot-one' });
      await staleFetch.promise;
    });

    expect(getAddressHistory).toHaveBeenCalledTimes(1);
    expect(getAddressHistory).not.toHaveBeenCalledWith({
      address: ADDRESS,
      start: 40,
      limit: 20,
      snapshotId: 'snapshot-one'
    });
    expect(screen.queryByText(/^from stale-source-/)).toBeNull();

    expect(screen.getByText('from active-source')).toBeTruthy();
    expect(screen.getByTestId('pagination-current-page').textContent).toBe('1');
    expect(screen.getByTestId('pagination-page-count').textContent).toBe('1');
    expect(showLoading).toHaveBeenLastCalledWith(false);
    expect(showLoading.mock.calls.filter(([show]) => show).length).toBe(1);
    expect(showLoading.mock.calls.filter(([show]) => !show).length).toBe(1);
  });
});
