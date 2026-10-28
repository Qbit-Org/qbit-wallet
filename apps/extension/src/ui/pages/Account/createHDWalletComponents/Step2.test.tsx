import type { ChangeEventHandler, CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  useChainType,
  useCreateAccountCallback,
  useI18n,
  useRestoreQbitWalletCallback,
  useTools,
  useWallet
} from '@qbit/wallet-state';
import { AddressType } from '@qbit/wallet-types';

import englishMessages from '../../../../_locales/en/messages.json';
import { Step2 } from './Step2';

const englishTranslations = englishMessages as Record<string, { message: string }>;

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    full,
    itemsCenter,
    justifyCenter,
    gap,
    size,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    full?: boolean;
    itemsCenter?: boolean;
    justifyCenter?: boolean;
    gap?: string;
    size?: number | string;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'div',
      {
        style,
        'data-testid': dataTestId,
        'data-full': full ? 'true' : undefined,
        'data-items-center': itemsCenter ? 'true' : undefined,
        'data-justify-center': justifyCenter ? 'true' : undefined,
        'data-gap': gap,
        'data-size': size
      },
      children
    );
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
  }) =>
    React.createElement(
      'button',
      { onClick: disabled ? undefined : onClick, disabled, 'data-testid': dataTestId },
      text
    );
  const Text = ({
    text,
    preset,
    textCenter,
    'data-testid': dataTestId
  }: {
    text?: string;
    preset?: string;
    textCenter?: boolean;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'span',
      {
        'data-testid': dataTestId,
        'data-preset': preset,
        'data-text-center': textCenter ? 'true' : undefined
      },
      text
    );
  const Input = ({
    defaultValue,
    value,
    onChange,
    'data-testid': dataTestId
  }: {
    defaultValue?: string;
    value?: string;
    onChange?: ChangeEventHandler<HTMLInputElement>;
    'data-testid'?: string;
  }) => React.createElement('input', { defaultValue, value, onChange, 'data-testid': dataTestId });

  return {
    Button,
    Card: Container,
    Column: Container,
    Icon: Container,
    Input,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/AddressTypeCard', () => ({ AddressTypeCard2: () => null }));
vi.mock('@/ui/components/FooterButtonContainer', async () => {
  const React = await import('react');
  return {
    FooterButtonContainer: ({ children }: { children?: ReactNode }) =>
      React.createElement('div', null, children)
  };
});
const navigateMock = vi.fn();
vi.mock('@/ui/pages/MainRoute', () => ({
  useNavigate: () => navigateMock
}));
vi.mock('@/ui/utils', () => ({ satoshisToAmount: () => '0' }));

vi.mock('@qbit/wallet-shared', async () => {
  const { AddressType: RealAddressType } = await import('@qbit/wallet-types');
  return {
    ADDRESS_TYPES: [{ name: 'P2MR', value: RealAddressType.P2MR, hdPath: '' }],
    getAccountDerivationPath: (hdPath: string, index: number) => `${hdPath}/${index}`,
    getQbitHdPathForChainType: () => "m/87'/0'/0'/0"
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useChainType: vi.fn(),
  useCreateAccountCallback: vi.fn(),
  useI18n: vi.fn(),
  useRestoreQbitWalletCallback: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const P2MR = AddressType.P2MR;

function completedReport(overrides: Record<string, unknown> = {}) {
  return {
    network: 'mainnet',
    accountsRestored: 3,
    discovery: { activeIndexes: [0, 2], highestActiveIndex: 2, scannedCount: 23, truncated: false },
    floorsCompleted: true,
    floorScan: {
      network: 'mainnet',
      keyringsScanned: 1,
      accountsScanned: 3,
      totalObservedSignatures: 5,
      restoredFloorCount: 2,
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false
    },
    ...overrides
  };
}

function contextData(isRestore: boolean) {
  return {
    mnemonics: 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango',
    hdPath: '',
    passphrase: '',
    addressType: P2MR,
    addressTypeIndex: 0,
    isRestore
  } as any;
}

describe('Step2 restore flow', () => {
  const createAccount = vi.fn();
  const restoreQbitWallet = vi.fn();
  const toastError = vi.fn();
  const runQbitRestoreFloorScan = vi.fn();
  const getQbitRestoreFloorsPending = vi.fn();
  const getQbitConcurrentInstanceHint = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string) => englishTranslations[key]?.message ?? key
    } as any);
    vi.mocked(useTools).mockReturnValue({ toastError } as any);
    vi.mocked(useChainType).mockReturnValue('QBIT_MAINNET' as any);
    vi.mocked(useCreateAccountCallback).mockReturnValue(createAccount);
    vi.mocked(useRestoreQbitWalletCallback).mockReturnValue(restoreQbitWallet);
    vi.mocked(useWallet).mockReturnValue({
      createTmpKeyringWithMnemonics: vi.fn(async () => ({
        accounts: [{ address: 'qb1qpreview0' }]
      })),
      getMultiAddressSummaries: vi.fn(async () => [{ totalSatoshis: 0 }]),
      runQbitRestoreFloorScan,
      getQbitRestoreFloorsPending,
      getQbitConcurrentInstanceHint
    } as any);
    getQbitConcurrentInstanceHint.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  function renderStep2(isRestore: boolean) {
    return render(<Step2 contextData={contextData(isRestore)} updateContextData={() => undefined} />);
  }

  it('runs restore orchestration and blocks navigation behind the report', async () => {
    restoreQbitWallet.mockResolvedValue(completedReport());
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report');
    expect(restoreQbitWallet).toHaveBeenCalledWith(
      'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango',
      "m/87'/0'/0'/0",
      '',
      P2MR
    );
    expect(createAccount).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('restore-report-warning-counters')).toBeTruthy();
    expect(screen.queryByTestId('restore-report-warning-concurrent')).toBeNull();
  });

  it('submits the latest passphrase when input and continue occur before a parent rerender', async () => {
    restoreQbitWallet.mockResolvedValue(completedReport());
    renderStep2(true);

    fireEvent.change(await screen.findByTestId('passphrase-input'), {
      target: { value: 'latest recovery passphrase' }
    });
    fireEvent.click(screen.getByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report');
    expect(restoreQbitWallet).toHaveBeenCalledWith(
      'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango',
      "m/87'/0'/0'/0",
      'latest recovery passphrase',
      P2MR
    );
  });

  it('ignores duplicate submissions while restore orchestration is pending', async () => {
    let resolveRestore!: (report: ReturnType<typeof completedReport>) => void;
    restoreQbitWallet.mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      })
    );
    renderStep2(true);

    const continueButton = await screen.findByTestId('address-type-continue-button');
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    expect(restoreQbitWallet).toHaveBeenCalledTimes(1);
    resolveRestore(completedReport());
    await screen.findByTestId('restore-report');
  });

  it('centers and enlarges the restore progress indicator', async () => {
    let resolveRestore!: (report: ReturnType<typeof completedReport>) => void;
    restoreQbitWallet.mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      })
    );
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    const scanning = await screen.findByTestId('restore-scanning');
    expect(scanning.getAttribute('data-full')).toBe('true');
    expect(scanning.getAttribute('data-items-center')).toBe('true');
    expect(scanning.getAttribute('data-justify-center')).toBe('true');
    expect(scanning.getAttribute('data-gap')).toBe('xl');
    expect(screen.getByTestId('restore-scanning-spinner').getAttribute('data-size')).toBe('42');
    expect(scanning.querySelector('[data-text-center="true"]')).toBeTruthy();

    resolveRestore(completedReport());
    await screen.findByTestId('restore-report');
  });

  it('raises the restoreScanning flag while the scan runs and clears it on the report', async () => {
    let resolveRestore!: (report: ReturnType<typeof completedReport>) => void;
    restoreQbitWallet.mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      })
    );
    const updateContextData = vi.fn();
    render(<Step2 contextData={contextData(true)} updateContextData={updateContextData} />);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-scanning');
    expect(updateContextData).toHaveBeenLastCalledWith({ restoreScanning: true });

    resolveRestore(completedReport());
    await screen.findByTestId('restore-report');
    expect(updateContextData).toHaveBeenLastCalledWith({ restoreScanning: false });
  });

  it('requests the parent scan lock before starting the restore call', async () => {
    let resolveRestore!: (report: ReturnType<typeof completedReport>) => void;
    restoreQbitWallet.mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      })
    );
    const updateContextData = vi.fn();
    render(<Step2 contextData={contextData(true)} updateContextData={updateContextData} />);
    updateContextData.mockClear();

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    // The mirror effect only runs after paint; during that gap the parent's
    // back/tab controls would stay interactive while the uncancellable
    // restore is already in flight, so the lock must be requested
    // synchronously before the restore call starts.
    const lockCallIndex = updateContextData.mock.calls.findIndex(
      ([params]) => (params as { restoreScanning?: boolean }).restoreScanning === true
    );
    expect(lockCallIndex).toBeGreaterThanOrEqual(0);
    expect(updateContextData.mock.invocationCallOrder[lockCallIndex]!).toBeLessThan(
      restoreQbitWallet.mock.invocationCallOrder[0]!
    );

    resolveRestore(completedReport());
    await screen.findByTestId('restore-report');
  });

  it('holds the restoreScanning lock while a floor-scan retry is in flight', async () => {
    restoreQbitWallet.mockResolvedValue(
      completedReport({
        floorsCompleted: false,
        floorScan: undefined,
        floorError: 'esplora unreachable'
      })
    );
    let resolveFloorScan!: (summary: Record<string, unknown>) => void;
    runQbitRestoreFloorScan.mockReturnValue(
      new Promise((resolve) => {
        resolveFloorScan = resolve;
      })
    );
    getQbitRestoreFloorsPending.mockResolvedValue(false);
    const updateContextData = vi.fn();
    render(<Step2 contextData={contextData(true)} updateContextData={updateContextData} />);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));
    await screen.findByTestId('restore-report-floors-incomplete');
    expect(updateContextData).toHaveBeenLastCalledWith({ restoreScanning: false });

    fireEvent.click(screen.getByTestId('restore-retry-button'));
    await waitFor(() => {
      expect(updateContextData).toHaveBeenLastCalledWith({ restoreScanning: true });
    });

    resolveFloorScan({
      network: 'mainnet',
      keyringsScanned: 1,
      accountsScanned: 3,
      totalObservedSignatures: 4,
      restoredFloorCount: 1,
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false
    });
    await waitFor(() => {
      expect(screen.queryByTestId('restore-report-floors-incomplete')).toBeNull();
    });
    expect(updateContextData).toHaveBeenLastCalledWith({ restoreScanning: false });
  });

  it('disables the report continue button while a floor-scan retry is in flight', async () => {
    restoreQbitWallet.mockResolvedValue(
      completedReport({
        floorsCompleted: false,
        floorScan: undefined,
        floorError: 'esplora unreachable'
      })
    );
    let resolveFloorScan!: (summary: Record<string, unknown>) => void;
    runQbitRestoreFloorScan.mockReturnValue(
      new Promise((resolve) => {
        resolveFloorScan = resolve;
      })
    );
    getQbitRestoreFloorsPending.mockResolvedValue(false);
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));
    await screen.findByTestId('restore-report-floors-incomplete');

    fireEvent.click(screen.getByTestId('restore-retry-button'));
    const continueButton = screen.getByTestId('restore-report-continue') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(continueButton);
    expect(navigateMock).not.toHaveBeenCalled();

    resolveFloorScan({
      network: 'mainnet',
      keyringsScanned: 1,
      accountsScanned: 3,
      totalObservedSignatures: 4,
      restoredFloorCount: 1,
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false
    });
    await waitFor(() => {
      expect((screen.getByTestId('restore-report-continue') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('restore-report-continue'));
    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  it('clears the restoreScanning flag when the restore fails', async () => {
    restoreQbitWallet.mockRejectedValue(new Error('esplora unreachable'));
    const updateContextData = vi.fn();
    render(<Step2 contextData={contextData(true)} updateContextData={updateContextData} />);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(updateContextData).toHaveBeenLastCalledWith({ restoreScanning: false });
  });

  it('surfaces the two-live-wallet warning when gap activity was observed', async () => {
    restoreQbitWallet.mockResolvedValue(
      completedReport({
        floorScan: {
          network: 'mainnet',
          keyringsScanned: 1,
          accountsScanned: 3,
          totalObservedSignatures: 5,
          restoredFloorCount: 2,
          gapIndexesWithActivity: [7],
          possibleConcurrentInstance: true
        }
      })
    );
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report');
    expect(screen.getByTestId('restore-report-warning-concurrent')).toBeTruthy();
  });

  it('separates and bolds the restored-counter reuse recommendation', async () => {
    restoreQbitWallet.mockResolvedValue(completedReport());
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report');
    expect(screen.getByTestId('restore-report-warning-counters').textContent).toContain(
      'Signature counters were rebuilt from public on-chain history and are minimums. ' +
        'Never-broadcast transactions and message signatures are invisible to this scan.'
    );
    const recommendation = screen.getByTestId('restore-report-warning-recommendation');
    expect(recommendation.textContent).toBe(
      "If this phrase was used in another wallet, it's highly recommended to move funds to a fresh wallet " +
        'instead of re-using old addresses.'
    );
    expect(recommendation.getAttribute('data-preset')).toBe('bold');
  });

  it.each([
    ['mainnet', 'Mainnet'],
    ['testnet4', 'Testnet4'],
    ['regtest', 'Regtest']
  ] as const)('capitalizes the %s network name in the restore report', async (network, expected) => {
    restoreQbitWallet.mockResolvedValue(completedReport({ network }));
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report');
    expect(screen.getByTestId('restore-report-network').textContent).toBe(expected);
  });

  it('centers and capitalizes the restore title and lists the network first', async () => {
    restoreQbitWallet.mockResolvedValue(completedReport());
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    const title = await screen.findByTestId('restore-report');
    expect(title.textContent).toBe('Wallet Restored');
    expect(title.getAttribute('data-text-center')).toBe('true');

    const reportPage = screen.getByTestId('restore-report-page');
    const networkRow = screen.getByTestId('restore-report-network-row');
    const accountsRow = screen.getByTestId('restore-report-accounts-row');
    const reportChildren = Array.from(reportPage.children);
    expect(reportChildren.indexOf(networkRow)).toBeLessThan(reportChildren.indexOf(accountsRow));
    expect(accountsRow.textContent).toContain('Addresses Restored');
  });

  it('hides the no-activity notice after restore', async () => {
    restoreQbitWallet.mockResolvedValue(
      completedReport({
        discovery: { activeIndexes: [], highestActiveIndex: -1, scannedCount: 20, truncated: false }
      })
    );
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report');
    expect(screen.queryByTestId('restore-report-no-activity')).toBeNull();
  });

  it('keeps the failure card until a floor-scan retry succeeds', async () => {
    restoreQbitWallet.mockResolvedValue(
      completedReport({
        floorsCompleted: false,
        floorScan: undefined,
        floorError: 'qbit address history changed while scanning'
      })
    );
    runQbitRestoreFloorScan.mockResolvedValue({
      network: 'mainnet',
      keyringsScanned: 1,
      accountsScanned: 3,
      totalObservedSignatures: 4,
      restoredFloorCount: 1,
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false
    });
    getQbitRestoreFloorsPending.mockResolvedValue(false);
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report-floors-incomplete');
    fireEvent.click(screen.getByTestId('restore-retry-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('restore-report-floors-incomplete')).toBeNull();
    });
    expect(runQbitRestoreFloorScan).toHaveBeenCalledTimes(1);
  });

  it('surfaces the persisted concurrent hint even when floors failed', async () => {
    restoreQbitWallet.mockResolvedValue(
      completedReport({
        floorsCompleted: false,
        floorScan: undefined,
        floorError: 'esplora unreachable'
      })
    );
    getQbitConcurrentInstanceHint.mockResolvedValue(true);
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report-floors-incomplete');
    await screen.findByTestId('restore-report-warning-concurrent');
  });

  it('keeps the failure card when a retry resolves without lifting the gate', async () => {
    restoreQbitWallet.mockResolvedValue(
      completedReport({
        floorsCompleted: false,
        floorScan: undefined,
        floorError: 'esplora unreachable'
      })
    );
    runQbitRestoreFloorScan.mockResolvedValue({
      network: 'mainnet',
      keyringsScanned: 0,
      accountsScanned: 0,
      totalObservedSignatures: 0,
      restoredFloorCount: 0,
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false
    });
    getQbitRestoreFloorsPending.mockResolvedValue(true);
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await screen.findByTestId('restore-report-floors-incomplete');
    fireEvent.click(screen.getByTestId('restore-retry-button'));

    await waitFor(() => {
      expect(getQbitRestoreFloorsPending).toHaveBeenCalled();
    });
    expect(screen.getByTestId('restore-report-floors-incomplete')).toBeTruthy();
    expect(toastError).toHaveBeenCalled();
  });

  it('navigates to the wallet only from the acknowledged report', async () => {
    restoreQbitWallet.mockResolvedValue(completedReport());
    renderStep2(true);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));
    fireEvent.click(await screen.findByTestId('restore-report-continue'));

    expect(navigateMock).toHaveBeenCalledWith('MainScreen');
  });

  it('leaves the create flow on the direct path without a report', async () => {
    createAccount.mockResolvedValue(undefined);
    renderStep2(false);

    fireEvent.click(await screen.findByTestId('address-type-continue-button'));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('MainScreen');
    });
    expect(createAccount).toHaveBeenCalled();
    expect(restoreQbitWallet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('restore-report')).toBeNull();
  });
});
