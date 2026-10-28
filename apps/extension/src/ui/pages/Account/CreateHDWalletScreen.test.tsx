import type { ChangeEventHandler, CSSProperties, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WordsType } from '@qbit/wallet-shared';
import {
  useChainType,
  useCreateAccountCallback,
  useCreateWalletLogicImportWordsStep,
  useI18n,
  useRestoreQbitWalletCallback,
  useTools,
  useWallet
} from '@qbit/wallet-state';
import { AddressType } from '@qbit/wallet-types';

import CreateHDWalletScreen from './CreateHDWalletScreen';
import { TabType } from './createHDWalletComponents/types';

vi.mock('react-router-dom', () => ({
  useLocation: vi.fn()
}));

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
    'data-testid': dataTestId
  }: {
    text?: string;
    preset?: string;
    'data-testid'?: string;
  }) => React.createElement('span', { 'data-testid': dataTestId, 'data-preset': preset }, text);
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
  const Header = ({
    onBack,
    backDisabled,
    children
  }: {
    onBack?: () => void;
    backDisabled?: boolean;
    children?: ReactNode;
  }) =>
    React.createElement(
      'div',
      null,
      onBack
        ? React.createElement('button', {
            'data-testid': 'header-back-button',
            disabled: backDisabled,
            onClick: backDisabled ? undefined : onBack
          })
        : null,
      children
    );

  return {
    Button,
    Card: Container,
    Column: Container,
    Content: Container,
    Grid: Container,
    Header,
    Icon: Container,
    Input,
    Layout: Container,
    Radio: Container,
    RadioGroup: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/AddressTypeCard', async () => {
  const React = await import('react');
  return {
    AddressTypeCard2: ({
      onClick,
      'data-testid': dataTestId
    }: {
      onClick?: () => void;
      'data-testid'?: string;
    }) => React.createElement('div', { onClick, 'data-testid': dataTestId })
  };
});
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
vi.mock('@/ui/utils', () => ({
  satoshisToAmount: () => '0',
  showLongNumber: (value: unknown) => `${value}`
}));

// Expose the create flow's selected word type without pulling antd into the
// module graph; Step1_Create's generation behavior has focused coverage.
vi.mock('./createHDWalletComponents/Step1_Create', async () => {
  const React = await import('react');
  return {
    Step1_Create: ({ contextData }: { contextData: { wordsType: number } }) =>
      React.createElement('div', {
        'data-testid': 'create-wallet-seed-step',
        'data-words-type': contextData.wordsType
      })
  };
});
vi.mock('./createHDWalletComponents/Step1_Confirm', () => ({ Step1_Confirm: () => null }));

vi.mock('@qbit/wallet-shared', async () => {
  const { AddressType: RealAddressType } = await import('@qbit/wallet-types');
  return {
    ADDRESS_TYPES: [{ name: 'P2MR', value: RealAddressType.P2MR, hdPath: '' }],
    WordsType: { WORDS_12: 0, WORDS_24: 1 },
    getAccountDerivationPath: (hdPath: string, index: number) => `${hdPath}/${index}`,
    getQbitHdPathForChainType: () => "m/87'/0'/0'/0"
  };
});

vi.mock('@qbit/wallet-state', () => ({
  useChainType: vi.fn(),
  useCreateAccountCallback: vi.fn(),
  useCreateWalletLogicImportWordsStep: vi.fn(),
  useI18n: vi.fn(),
  useRestoreQbitWalletCallback: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const P2MR = AddressType.P2MR;
const TEST_MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango';
const RECOVERY_PASSPHRASE = 'G3 recovery passphrase';

function completedReport() {
  return {
    network: 'regtest',
    accountsRestored: 2,
    discovery: { activeIndexes: [0, 1], highestActiveIndex: 1, scannedCount: 22, truncated: false },
    floorsCompleted: true,
    floorScan: {
      network: 'regtest',
      keyringsScanned: 1,
      accountsScanned: 2,
      totalObservedSignatures: 2,
      restoredFloorCount: 2,
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false
    }
  };
}

describe('CreateHDWalletScreen', () => {
  const restoreQbitWallet = vi.fn();
  const createAccount = vi.fn();
  const toastError = vi.fn();
  const setLastActiveTime = vi.fn();
  const lockWallet = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useLocation).mockReturnValue({
      state: { isImport: true, fromUnlock: false }
    } as ReturnType<typeof useLocation>);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useTools).mockReturnValue({ toastError } as any);
    vi.mocked(useChainType).mockReturnValue('QBIT_REGTEST' as any);
    vi.mocked(useCreateAccountCallback).mockReturnValue(createAccount);
    vi.mocked(useRestoreQbitWalletCallback).mockReturnValue(restoreQbitWallet);
    vi.mocked(useWallet).mockReturnValue({
      // Previews stay in flight, matching the CI run where the background is
      // still deriving when Continue is clicked.
      createTmpKeyringWithMnemonics: vi.fn(() => new Promise(() => undefined)),
      getMultiAddressSummaries: vi.fn(async () => [{ totalSatoshis: 0 }]),
      getQbitConcurrentInstanceHint: vi.fn(async () => false),
      setLastActiveTime,
      lockWallet
    } as any);
    // Mirrors the restore branch of onClickNext in
    // packages/wallet-state/src/ui-hooks/useCreateWalletLogicImportWordsStep.ts:
    // one updateContextData call carrying the mnemonic and the tab switch.
    vi.mocked(useCreateWalletLogicImportWordsStep).mockImplementation((params: any) => ({
      wordsItems: [],
      t: (key: string) => key,
      onHandleEventPaste: vi.fn(),
      inputWords: [],
      onClickNext: () => {
        params.updateContextData({
          mnemonics: TEST_MNEMONIC,
          tabType: TabType.CHOOSE_ADDRESS_TYPE
        });
      },
      onClickWordsItem: vi.fn(),
      onInputWordsChange: vi.fn(),
      disabled: false
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it('defaults new wallets to 24-word recovery phrases', () => {
    vi.mocked(useLocation).mockReturnValue({
      state: { isImport: false, fromUnlock: false }
    } as ReturnType<typeof useLocation>);

    render(<CreateHDWalletScreen />);

    expect(screen.getByTestId('create-wallet-seed-step').getAttribute('data-words-type')).toBe(
      String(WordsType.WORDS_24)
    );
  });

  it('stops refreshing and locks after ten minutes of wall time when the monotonic clock is frozen', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(0);
    render(<CreateHDWalletScreen />);

    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(59);
    expect(lockWallet).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(59);
    // The last refresh re-armed the background lock timer for the full
    // configured auto-lock duration, so the deadline is enforced with an
    // explicit lock instead of waiting out that timer.
    expect(lockWallet).toHaveBeenCalledTimes(1);
  });

  it('stops refreshing wallet activity when wall time moves backward and the monotonic clock is frozen', () => {
    vi.useFakeTimers();
    let wallClockTime = 100_000;
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(Date, 'now').mockImplementation(() => wallClockTime);
    render(<CreateHDWalletScreen />);

    act(() => {
      wallClockTime += 10 * 1000;
      vi.advanceTimersByTime(10 * 1000);
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(1);

    act(() => {
      wallClockTime -= 1;
      vi.advanceTimersByTime(10 * 1000);
      wallClockTime += 60 * 1000;
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(1);
    // The backward jump only stops refreshing; the scheduled lock still ends
    // the grace period at the monotonic deadline.
    expect(lockWallet).not.toHaveBeenCalled();
  });

  it('retains the ten-minute monotonic cutoff when wall time does not advance', () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    vi.spyOn(Date, 'now').mockReturnValue(0);
    render(<CreateHDWalletScreen />);

    act(() => {
      for (let tick = 1; tick < 60; tick += 1) {
        monotonicNow = tick * 10 * 1000;
        vi.advanceTimersByTime(10 * 1000);
      }
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(59);

    act(() => {
      monotonicNow = 10 * 60 * 1000;
      vi.advanceTimersByTime(10 * 1000);
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(59);
    expect(lockWallet).toHaveBeenCalledTimes(1);
  });

  it('stops refreshing wallet activity when the screen unmounts', () => {
    vi.useFakeTimers();
    const { unmount } = render(<CreateHDWalletScreen />);

    act(() => {
      vi.advanceTimersByTime(10 * 1000);
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000);
    });
    expect(setLastActiveTime).toHaveBeenCalledTimes(1);
    // Leaving the screen ends the seed exposure, so the deadline lock is
    // cancelled with it and normal auto-lock behavior resumes.
    expect(lockWallet).not.toHaveBeenCalled();
  });

  it('delivers the typed passphrase to restore when the tab snap-back timer fires between input and continue', async () => {
    restoreQbitWallet.mockResolvedValue(completedReport());
    vi.useFakeTimers();

    render(<CreateHDWalletScreen />);

    // Step 1 -> Step 2: the programmatic tab change makes the TabBar invoke
    // onTabClick, which arms the parent's 200ms snap-back timer against the
    // pre-passphrase contextData snapshot (step1CreateWordsCompleted is never
    // set in the restore flow).
    fireEvent.click(screen.getByTestId('mnemonic-import-continue-button'));
    expect(screen.getByTestId('address-type-title')).toBeTruthy();

    // The Playwright page object clicks the P2MR card before typing.
    fireEvent.click(screen.getByTestId('address-type-card-0'));
    fireEvent.change(screen.getByTestId('passphrase-input'), {
      target: { value: RECOVERY_PASSPHRASE }
    });

    // CI loses this race: the stale snap-back timer fires after the fill but
    // before Continue is clicked.
    act(() => {
      vi.advanceTimersByTime(250);
    });

    fireEvent.click(screen.getByTestId('address-type-continue-button'));

    expect(restoreQbitWallet).toHaveBeenCalledTimes(1);
    expect(restoreQbitWallet).toHaveBeenCalledWith(
      TEST_MNEMONIC,
      "m/87'/0'/0'/0",
      RECOVERY_PASSPHRASE,
      P2MR
    );
    expect(createAccount).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('restore-report')).toBeTruthy();
  });

  it('locks the header back button and step tabs only while the chain scan is in flight', async () => {
    let resolveRestore!: (report: ReturnType<typeof completedReport>) => void;
    restoreQbitWallet.mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      })
    );
    render(<CreateHDWalletScreen />);

    fireEvent.click(screen.getByTestId('mnemonic-import-continue-button'));
    const backButton = screen.getByTestId('header-back-button') as HTMLButtonElement;
    expect(backButton.disabled).toBe(false);

    fireEvent.click(screen.getByTestId('address-type-continue-button'));
    await screen.findByTestId('restore-scanning');
    expect((screen.getByTestId('header-back-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('hd-wallet-tabbar').style.pointerEvents).toBe('none');

    await act(async () => {
      resolveRestore(completedReport());
    });
    expect(screen.getByTestId('restore-report')).toBeTruthy();
    expect((screen.getByTestId('header-back-button') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('hd-wallet-tabbar').style.pointerEvents).not.toBe('none');
  });
});
