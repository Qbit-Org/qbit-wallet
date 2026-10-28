import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { p2mrAddressFromRoot, parseQbitUri as parseProtocolQbitUri } from '@qbit-oss/protocol';
import { parseQbitUri } from '@qbit/wallet-shared';
import type {
  QbitCounterProvenance,
  QbitReceiveAddressState,
  QbitReceiveState,
  QbitSignatureBudgetState
} from '@qbit/wallet-shared';
import { useAccountAddress, useChain, useCurrentAccount, useI18n, useTools, useWallet } from '@qbit/wallet-state';

import ReceiveScreen from './index';

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

  return {
    Column: Container,
    Content: Container,
    Header: ({ title }: { title?: string }) => React.createElement('header', null, title),
    Icon: () => React.createElement('span', { 'data-testid': 'icon' }),
    Layout: Container,
    Row: Container,
    Text: ({ text }: { text?: string }) => React.createElement('span', null, text)
  };
});

vi.mock('@/ui/utils', () => ({
  shortAddress: (address = '', length = 8) =>
    address.length > length * 2 ? `${address.slice(0, length)}...${address.slice(-length)}` : address
}));

vi.mock('@/shared/constant', () => ({
  IMAGE_SOURCE_MAP: { qbitMainnet: 'mainnet.svg', qbitTestnet: 'testnet.svg' }
}));

vi.mock('qrcode.react', async () => {
  const React = await import('react');
  return {
    default: ({ value }: { value: string }) =>
      React.createElement('div', { 'data-testid': 'qrcode-value', 'data-value': value })
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useAccountAddress: vi.fn(),
  useChain: vi.fn(),
  useCurrentAccount: vi.fn(),
  useI18n: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

function addressState(
  index: number,
  state: QbitSignatureBudgetState,
  provenance: QbitCounterProvenance,
  used: boolean
): QbitReceiveAddressState {
  const remaining = { normal: 900, warning: 200, critical: 20, exhausted: 0 }[state];
  return {
    index,
    address: p2mrAddressFromRoot(
      Uint8Array.from({ length: 32 }, (_, byte) => (byte === 31 ? index + 1 : 0)),
      'mainnet'
    ),
    used,
    signatureCounter: {
      count: 1000 - remaining,
      limit: 1000,
      remaining,
      state,
      provenance,
      knownOnChainSignatures: provenance === 'restored-floor' ? 12 : 0
    }
  };
}

function receiveState(overrides: Partial<QbitReceiveState> = {}): QbitReceiveState {
  return {
    network: 'mainnet',
    current: addressState(0, 'normal', 'local', false),
    previous: [
      addressState(1, 'warning', 'local', true),
      addressState(2, 'critical', 'restored-floor', false),
      addressState(3, 'exhausted', 'restored-floor', true)
    ],
    gap: {
      limit: 20,
      highestUsedIndex: 1,
      trailingUnusedCount: 2,
      remainingIntentCapacity: 18,
      canCreate: true
    },
    activityStatus: 'live',
    floorsPending: false,
    concurrentInstanceHint: false,
    ...overrides
  };
}

describe('ReceiveScreen custody flow', () => {
  const ensureQbitReceiveIntent = vi.fn();
  const createQbitReceiveIntent = vi.fn();
  const getQbitReceiveState = vi.fn();
  const copyToClipboard = vi.fn();
  const toastError = vi.fn();
  const toastWarning = vi.fn();
  let chain: { enum: string; icon: 'qbitMainnet' | 'qbitTestnet' };

  beforeEach(() => {
    vi.clearAllMocks();
    chain = { enum: 'QBIT_MAINNET', icon: 'qbitMainnet' };
    const initialState = receiveState();
    ensureQbitReceiveIntent.mockResolvedValue(initialState);
    createQbitReceiveIntent.mockResolvedValue(initialState);
    getQbitReceiveState.mockResolvedValue(initialState);
    vi.mocked(useAccountAddress).mockReturnValue(initialState.current!.address);
    vi.mocked(useChain).mockImplementation(() => chain as any);
    vi.mocked(useCurrentAccount).mockReturnValue({
      key: 'keyring_0#0',
      pubkey: 'pubkey-0',
      p2mr: true,
      alianName: 'Primary'
    } as any);
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, ...args: string[]) => (args.length ? `${key}(${args.join(',')})` : key)
    } as any);
    vi.mocked(useTools).mockReturnValue({
      copyToClipboard,
      toastError,
      toastWarning
    } as any);
    vi.mocked(useWallet).mockReturnValue({
      ensureQbitReceiveIntent,
      createQbitReceiveIntent,
      getQbitReceiveState
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('ensures without creating on repeated renders and visits', async () => {
    const first = render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    first.rerender(<ReceiveScreen />);
    expect(ensureQbitReceiveIntent).toHaveBeenCalledTimes(1);
    expect(createQbitReceiveIntent).not.toHaveBeenCalled();

    first.unmount();
    render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');
    expect(ensureQbitReceiveIntent).toHaveBeenCalledTimes(2);
    expect(createQbitReceiveIntent).not.toHaveBeenCalled();
  });

  it('creates exactly one intent only from New Address', async () => {
    const initial = receiveState();
    const next = receiveState({
      current: addressState(4, 'normal', 'local', false),
      previous: [initial.current!, ...initial.previous]
    });
    createQbitReceiveIntent.mockResolvedValue(next);
    render(<ReceiveScreen />);

    fireEvent.click(await screen.findByTestId('new-address'));

    await waitFor(() =>
      expect(screen.getByTestId('qrcode-value').getAttribute('data-value')).toBe(`qbit:${next.current!.address}`)
    );
    expect(createQbitReceiveIntent).toHaveBeenCalledTimes(1);
    expect(ensureQbitReceiveIntent).toHaveBeenCalledTimes(1);
  });

  it('keeps the New Address result when account selection follows the durable intent', async () => {
    const initial = receiveState();
    const next = receiveState({
      current: addressState(4, 'normal', 'local', false),
      previous: [initial.current!, ...initial.previous]
    });
    let account = {
      key: 'keyring_0#0',
      pubkey: 'pubkey-0',
      p2mr: true,
      alianName: 'Primary'
    };
    let resolveCreate!: (state: QbitReceiveState) => void;
    vi.mocked(useCurrentAccount).mockImplementation(() => account as any);
    createQbitReceiveIntent.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );
    const view = render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');
    fireEvent.change(screen.getByLabelText('qbit_receive_amount_optional'), {
      target: { value: '1.25' }
    });

    fireEvent.click(screen.getByTestId('new-address'));
    account = { ...account, key: 'keyring_0#4', pubkey: 'pubkey-4' };
    view.rerender(<ReceiveScreen />);
    await act(async () => {
      resolveCreate(next);
    });

    await waitFor(() =>
      expect(screen.getByTestId('qrcode-value').getAttribute('data-value')).toBe(`qbit:${next.current!.address}`)
    );
    expect((screen.getByLabelText('qbit_receive_amount_optional') as HTMLInputElement).value).toBe('');
    expect(ensureQbitReceiveIntent).toHaveBeenCalledTimes(1);
    expect(createQbitReceiveIntent).toHaveBeenCalledTimes(1);
  });

  it('hides stale receive state while switching networks', async () => {
    let resolveTestnet!: (state: QbitReceiveState) => void;
    ensureQbitReceiveIntent.mockResolvedValueOnce(receiveState()).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTestnet = resolve;
      })
    );
    const view = render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    chain = { enum: 'QBIT_TESTNET4', icon: 'qbitTestnet' };
    view.rerender(<ReceiveScreen />);

    expect(screen.queryByTestId('receive-qr')).toBeNull();
    expect(screen.getByTestId('receive-loading')).toBeTruthy();

    const testnetState = receiveState({
      network: 'testnet4',
      current: addressState(9, 'normal', 'local', false)
    });
    await act(async () => {
      resolveTestnet(testnetState);
    });
    await screen.findByTestId('receive-qr');
    expect(screen.getByTestId('qrcode-value').getAttribute('data-value')).toBe(`qbit:${testnetState.current!.address}`);
  });

  it('does not copy an old-network address when the network changes during refresh', async () => {
    let resolveRefresh!: (state: QbitReceiveState) => void;
    const mainnetState = receiveState();
    const testnetState = receiveState({
      network: 'testnet4',
      current: addressState(8, 'normal', 'local', false)
    });
    ensureQbitReceiveIntent
      .mockResolvedValueOnce(mainnetState)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
      )
      .mockResolvedValueOnce(testnetState);
    const view = render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    fireEvent.click(screen.getByLabelText('copy_address'));
    chain = { enum: 'QBIT_TESTNET4', icon: 'qbitTestnet' };
    view.rerender(<ReceiveScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('qrcode-value').getAttribute('data-value')).toBe(
        `qbit:${testnetState.current!.address}`
      )
    );

    await act(async () => {
      resolveRefresh(mainnetState);
    });
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('round-trips optional amount and label and rejects an invalid amount safely', async () => {
    render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    fireEvent.change(screen.getByLabelText('qbit_receive_amount_optional'), {
      target: { value: '1.25000000' }
    });
    fireEvent.change(screen.getByLabelText('qbit_receive_label_optional'), {
      target: { value: 'Coffee & croissant' }
    });

    const uri = screen.getByTestId('qrcode-value').getAttribute('data-value')!;
    expect(parseQbitUri(uri)).toEqual({
      address: receiveState().current!.address,
      amount: '1.25000000',
      label: 'Coffee & croissant'
    });
    expect(parseProtocolQbitUri(uri, 'mainnet')).toMatchObject({
      address: receiveState().current!.address,
      network: 'mainnet',
      amount: '1.25000000',
      label: 'Coffee & croissant'
    });

    fireEvent.click(screen.getByRole('button', { name: 'qbit_receive_copy_uri' }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(uri));

    fireEvent.change(screen.getByLabelText('qbit_receive_amount_optional'), {
      target: { value: '01.0' }
    });
    expect(screen.queryByTestId('qrcode-value')).toBeNull();
    expect(screen.getByTestId('receive-qr-invalid')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'qbit_receive_copy_uri' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns before copying when activity appeared on the current address', async () => {
    const initialState = receiveState();
    const observedCurrent = { ...initialState.current!, used: true };
    ensureQbitReceiveIntent.mockResolvedValueOnce(initialState).mockResolvedValueOnce(
      receiveState({
        current: addressState(4, 'normal', 'local', false),
        previous: [observedCurrent, ...initialState.previous]
      })
    );
    render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    fireEvent.click(screen.getByLabelText('copy_address'));

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('qbit_receive_reuse_warning'));
    expect(copyToClipboard).toHaveBeenCalledWith(initialState.current!.address);
  });

  it('keeps low-budget badges visible on restored floors while hiding their normal claim', async () => {
    ensureQbitReceiveIntent.mockResolvedValueOnce(
      receiveState({
        previous: [
          addressState(1, 'warning', 'local', true),
          addressState(2, 'critical', 'restored-floor', false),
          addressState(3, 'exhausted', 'restored-floor', true),
          addressState(4, 'normal', 'restored-floor', false)
        ]
      })
    );
    render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    for (const state of ['warning', 'critical', 'exhausted']) {
      expect(screen.getAllByTestId(`budget-state-${state}`).length).toBeGreaterThan(0);
    }
    // Only the local current address substantiates a "Normal" claim; the
    // restored-floor address with an unknowable exact budget hides it.
    expect(screen.getAllByTestId('budget-state-normal')).toHaveLength(1);
    expect(screen.getAllByTestId('counter-provenance-local').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('counter-provenance-restored-floor').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('restored-floor-budget-details')).toHaveLength(3);
    expect(screen.getAllByText('qbit_recovery_status_seed_only')).toHaveLength(3);
    expect(screen.getAllByText('qbit_counter_confidence_chain_floor_only')).toHaveLength(3);
    expect(screen.getAllByText('qbit_known_onchain_usage_lower_bound(12+)')).toHaveLength(3);
    expect(screen.queryByText('qbit_receive_budget_available(12)')).toBeNull();

    const exhaustedCopy = screen.getByRole('button', { name: 'copy_address 3' });
    expect((exhaustedCopy as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'copy_address 1' }));
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('qbit_receive_reuse_warning'));
    expect(copyToClipboard).toHaveBeenCalledWith(receiveState().previous[0].address);
  });

  it('blocks a previous address that became exhausted before copy', async () => {
    const initialState = receiveState();
    const selected = initialState.previous[1];
    if (!selected) throw new Error('missing previous-address fixture');
    ensureQbitReceiveIntent.mockResolvedValueOnce(initialState).mockResolvedValueOnce(
      receiveState({
        previous: [
          initialState.previous[0],
          addressState(selected.index, 'exhausted', 'restored-floor', selected.used),
          initialState.previous[2]
        ]
      })
    );
    render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    fireEvent.click(screen.getByRole('button', { name: 'copy_address 2' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('qbit_receive_exhausted_copy_blocked'));
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('blocks a current address that became exhausted and renders its safe replacement', async () => {
    const initialState = receiveState();
    const exhaustedCurrent = addressState(0, 'exhausted', 'local', false);
    const replacement = addressState(4, 'normal', 'local', false);
    ensureQbitReceiveIntent.mockResolvedValueOnce(initialState).mockResolvedValueOnce(
      receiveState({
        current: replacement,
        previous: [exhaustedCurrent, ...initialState.previous]
      })
    );
    render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');

    fireEvent.click(screen.getByLabelText('copy_address'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('qbit_receive_exhausted_copy_blocked'));
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(screen.getByTestId('qrcode-value').getAttribute('data-value')).toBe(`qbit:${replacement.address}`);
  });

  it('offers no receive address until restored counter reconstruction completes', async () => {
    ensureQbitReceiveIntent.mockResolvedValue(
      receiveState({
        current: null,
        previous: [],
        floorsPending: true,
        gap: {
          limit: 20,
          highestUsedIndex: -1,
          trailingUnusedCount: 0,
          remainingIntentCapacity: 20,
          canCreate: false
        }
      })
    );
    render(<ReceiveScreen />);

    expect(await screen.findByTestId('floors-pending-warning')).toBeTruthy();
    expect(screen.getByTestId('no-safe-receive-address')).toBeTruthy();
    expect(screen.queryByTestId('receive-qr')).toBeNull();
    expect(screen.queryByTestId('gap-limit-warning')).toBeNull();
    expect(createQbitReceiveIntent).not.toHaveBeenCalled();
  });

  it('offers no receive address and blocks copy when activity refresh is unavailable', async () => {
    const initial = receiveState();
    const cached = receiveState({
      activityStatus: 'cached',
      gap: { ...initial.gap, canCreate: false }
    });
    ensureQbitReceiveIntent.mockResolvedValueOnce(cached);
    render(<ReceiveScreen />);

    expect(await screen.findByTestId('activity-cached-warning')).toBeTruthy();
    expect(screen.getByTestId('no-safe-receive-address')).toBeTruthy();
    expect(screen.queryByTestId('receive-qr')).toBeNull();
    expect(screen.queryByText('qbit_receive_previous')).toBeNull();

    ensureQbitReceiveIntent.mockResolvedValueOnce(initial).mockResolvedValueOnce(cached);
    cleanup();
    render(<ReceiveScreen />);
    await screen.findByTestId('receive-qr');
    fireEvent.click(screen.getByLabelText('copy_address'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('qbit_receive_activity_cached'));
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(screen.queryByTestId('receive-qr')).toBeNull();
  });

  it('never suggests an exhausted address when the restoration gap is full', async () => {
    ensureQbitReceiveIntent.mockResolvedValue(
      receiveState({
        current: null,
        previous: [addressState(19, 'exhausted', 'restored-floor', true)],
        gap: {
          limit: 20,
          highestUsedIndex: -1,
          trailingUnusedCount: 20,
          remainingIntentCapacity: 0,
          canCreate: false
        }
      })
    );
    render(<ReceiveScreen />);

    expect(await screen.findByTestId('no-safe-receive-address')).toBeTruthy();
    expect(screen.getByTestId('gap-limit-warning')).toBeTruthy();
    expect(screen.queryByTestId('receive-qr')).toBeNull();
    expect((screen.getByRole('button', { name: 'copy_address 19' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
