import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { copyToClipboard } from '@/ui/utils';
import { ErrorCodes, WordsType } from '@qbit/wallet-shared';
import { useI18n, useQbitUnit, useTools, useWallet } from '@qbit/wallet-state';

import QbitRecoveryMigrationScreen from './QbitRecoveryMigrationScreen';

const navigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: { sourceKeyringIndex: 2, sourceAnchorPubkey: 'ab'.repeat(32) } })
}));

vi.mock('../MainRoute', () => ({
  useNavigate: () => navigate
}));

vi.mock('@/ui/pages/Account/createHDWalletComponents/Step1_Create', async () => {
  const React = await import('react');
  return {
    Step1_Create: ({
      contextData,
      updateContextData
    }: {
      contextData: { mnemonics: string; wordsType: WordsType };
      updateContextData: (data: Record<string, unknown>) => void;
    }) =>
      // Renders the wizard-held phrase so tests can observe whether returning
      // from verification kept the originally generated seed.
      React.createElement(
        'button',
        {
          'data-testid': 'create-fresh-seed',
          'data-words-type': contextData.wordsType,
          onClick: () =>
            updateContextData({
              mnemonics: 'fresh seed words stay inside the encrypted wallet handoff',
              tabType: 'VERIFY_WORDS'
            })
        },
        contextData.mnemonics || 'create-fresh-seed'
      )
  };
});

vi.mock('@/ui/pages/Account/createHDWalletComponents/Step1_Confirm', async () => {
  const React = await import('react');
  return {
    Step1_Confirm: ({ updateContextData }: { updateContextData: (data: Record<string, unknown>) => void }) =>
      React.createElement(
        'button',
        {
          'data-testid': 'confirm-fresh-seed-backup',
          onClick: () =>
            updateContextData({
              step1CreateWordsCompleted: true,
              tabType: 'CHOOSE_ADDRESS_TYPE'
            })
        },
        'confirm-fresh-seed-backup'
      )
  };
});

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({
    children,
    style,
    onClick,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);
  const Button = ({
    text,
    disabled,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('button', { disabled, onClick, 'data-testid': dataTestId }, text);
  const Checkbox = ({
    children,
    checked,
    onChange,
    'data-testid': dataTestId
  }: {
    children?: ReactNode;
    checked?: boolean;
    onChange?: (event: { target: { checked: boolean } }) => void;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'label',
      null,
      React.createElement('input', {
        type: 'checkbox',
        checked,
        onChange,
        'data-testid': dataTestId
      }),
      children
    );
  const Header = ({ title, onBack }: { title?: string; onBack?: () => void }) =>
    React.createElement(
      'header',
      null,
      React.createElement('button', { 'data-testid': 'header-back', onClick: onBack }),
      title
    );
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = ({ onClick, 'data-testid': dataTestId }: { onClick?: () => void; 'data-testid'?: string }) =>
    React.createElement('span', { onClick, 'data-testid': dataTestId });

  return {
    Button,
    Card: Container,
    Checkbox,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header,
    Icon,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/Popover', async () => {
  const React = await import('react');
  return {
    Popover: ({ children, 'data-testid': dataTestId }: { children?: ReactNode; 'data-testid'?: string }) =>
      React.createElement('div', { 'data-testid': dataTestId }, children)
  };
});

vi.mock('@/ui/utils', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  shortAddress: (address?: string, len = 8) => {
    if (!address) return '';
    if (address.length <= len * 2) return address;
    return address.slice(0, len) + '...' + address.slice(address.length - len);
  }
}));

vi.mock('@qbit/wallet-state', () => ({
  useChainType: () => 'QBIT_TESTNET4',
  useI18n: vi.fn(),
  useQbitUnit: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const seedOnlyState = {
  status: 'seed-only-restored',
  acknowledgement: 'required',
  counterConfidence: 'chain-floor-only',
  knownOnChainSignatures: 4
} as any;
const migratingState = {
  ...seedOnlyState,
  status: 'migrating',
  acknowledgement: 'accepted',
  migration: {
    destinationKeyringIndex: 3,
    destinationAddress: 'qbrt1zfreshdestination',
    network: 'regtest',
    plans: [
      {
        id: 'plan-1',
        sourceAddress: 'qbrt1zrecovered',
        destinationAddress: 'qbrt1zfreshdestination',
        amount: 46_000,
        fee: 4_000,
        status: 'prepared'
      }
    ]
  }
} as any;
const toSignData = {
  psbtHex: '70736274ff00',
  toSignInputs: [{ index: 0, publicKey: '11'.repeat(32) }],
  signatureBudget: {
    required: 1,
    cached: 0,
    remainingBefore: 100,
    remainingAfter: 99,
    limit: 1073741824,
    restoredFloorRisk: {
      recoveryStatus: 'seed-only-restored',
      counterConfidence: 'chain-floor-only',
      knownOnChainSignatures: 4,
      challengeId: 'migration-challenge'
    }
  },
  qbitRecoveryMigration: {
    sourceKeyringIndex: 2,
    destinationKeyringIndex: 3,
    network: 'regtest',
    planId: 'plan-1',
    sourceAddress: 'qbrt1zrecovered',
    destinationAddress: 'qbrt1zfreshdestination'
  }
} as any;

describe('QbitRecoveryMigrationScreen', () => {
  const wallet = {
    getQbitRecoveryState: vi.fn(),
    createQbitRecoveryMigrationWallet: vi.fn(),
    beginQbitRecoveryMigrationToExistingDestination: vi.fn(),
    advanceQbitRecoveryMigration: vi.fn(),
    prepareQbitRecoveryMigration: vi.fn(),
    confirmQbitRestoredFloorSigning: vi.fn(),
    releaseQbitRestoredFloorSigningChallenges: vi.fn(),
    signPsbtV2: vi.fn(),
    setLastActiveTime: vi.fn(),
    lockWallet: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    wallet.getQbitRecoveryState.mockResolvedValue(seedOnlyState);
    wallet.createQbitRecoveryMigrationWallet.mockResolvedValue(migratingState);
    wallet.beginQbitRecoveryMigrationToExistingDestination.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockResolvedValueOnce(migratingState).mockResolvedValueOnce({
      ...migratingState,
      status: 'migrated',
      migration: {
        ...migratingState.migration,
        plans: [{ ...migratingState.migration.plans[0], status: 'confirmed', txid: 'aa'.repeat(32) }]
      }
    });
    wallet.prepareQbitRecoveryMigration.mockResolvedValue({
      state: migratingState,
      toSignDatas: [toSignData]
    });
    wallet.confirmQbitRestoredFloorSigning.mockResolvedValue(undefined);
    wallet.releaseQbitRestoredFloorSigningChallenges.mockResolvedValue(undefined);
    wallet.signPsbtV2.mockResolvedValue({ psbtHex: 'signed' });
    wallet.setLastActiveTime.mockResolvedValue(undefined);
    wallet.lockWallet.mockResolvedValue(undefined);
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
    vi.mocked(useTools).mockReturnValue({ toastError: vi.fn(), toastSuccess: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue(wallet as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  // The keepalive tests cannot use findBy* queries: waitFor polls with real
  // timers, which the fake-timer installation replaces. The initial load only
  // needs its already-resolved wallet promises flushed to reach the seed stage.
  const flushInitialLoad = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('defaults fresh recovery migration wallets to 24-word recovery phrases', async () => {
    render(<QbitRecoveryMigrationScreen />);

    expect((await screen.findByTestId('create-fresh-seed')).getAttribute('data-words-type')).toBe(
      String(WordsType.WORDS_24)
    );
  });

  it('requires normal fresh-seed confirmation, exact review, guarded signing, and ends archived', async () => {
    render(<QbitRecoveryMigrationScreen />);

    await screen.findByTestId('create-fresh-seed');
    expect(wallet.createQbitRecoveryMigrationWallet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('create-fresh-seed'));
    expect(await screen.findByTestId('confirm-fresh-seed-backup')).toBeTruthy();
    expect(wallet.createQbitRecoveryMigrationWallet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-fresh-seed-backup'));
    await waitFor(() =>
      expect(wallet.createQbitRecoveryMigrationWallet).toHaveBeenCalledWith({
        sourceKeyringIndex: 2,
        sourceAnchorPubkey: 'ab'.repeat(32),
        mnemonic: 'fresh seed words stay inside the encrypted wallet handoff',
        hdPath: '',
        passphrase: ''
      })
    );
    // The stable anchor identity rides along so a queued operation can
    // re-resolve the source index after keyring compaction.
    expect(wallet.getQbitRecoveryState).toHaveBeenCalledWith(2, 'ab'.repeat(32));

    expect((await screen.findByTestId('qbit-recovery-destination')).textContent).toBe(
      'qbit_recovery_destination_labelqbrt1z...nation'
    );
    expect(screen.getByTestId('qbit-recovery-amount').textContent).toContain('QBT');
    expect(screen.getByTestId('qbit-recovery-fee').textContent).toContain('QBT');
    expect(screen.getByTestId('qbit-recovery-known-onchain-usage').textContent).toBe(
      'qbit_known_onchain_usage_lower_bound:4+'
    );
    expect(screen.getByText('qbit_recovery_migration_consequence')).toBeTruthy();

    // The truncated destination stays verifiable: copy the exact value or
    // reveal it in full before signing.
    fireEvent.click(screen.getByTestId('qbit-recovery-copy-address'));
    expect(vi.mocked(copyToClipboard)).toHaveBeenCalledWith('qbrt1zfreshdestination');
    expect(screen.queryByTestId('qbit-recovery-full-address')).toBeNull();
    fireEvent.click(screen.getByTestId('qbit-recovery-reveal-address'));
    expect(screen.getByTestId('qbit-recovery-full-address').textContent).toBe('qbrt1zfreshdestination');
    fireEvent.click(screen.getByTestId('qbit-recovery-copy-full-address'));
    expect(vi.mocked(copyToClipboard)).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('qbit-recovery-close-address-popover'));
    expect(screen.queryByTestId('qbit-recovery-full-address')).toBeNull();

    const signButton = screen.getByTestId('qbit-recovery-sign-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('qbit-recovery-review-confirmation'));
    expect(signButton.disabled).toBe(false);
    fireEvent.click(signButton);

    await waitFor(() => expect(wallet.confirmQbitRestoredFloorSigning).toHaveBeenCalledWith('migration-challenge'));
    await waitFor(() => expect(wallet.signPsbtV2).toHaveBeenCalledWith(toSignData));
    expect(await screen.findByTestId('qbit-recovery-complete')).toBeTruthy();
    expect(screen.getByTestId('qbit-recovery-complete-destination').textContent).toBe('qbrt1zfreshdestination');
    expect(screen.getByText('qbrt1zrecovered')).toBeTruthy();
    fireEvent.click(screen.getByTestId('qbit-recovery-copy-destination'));
    expect(vi.mocked(copyToClipboard)).toHaveBeenCalledWith('qbrt1zfreshdestination');
    expect(wallet.advanceQbitRecoveryMigration).toHaveBeenCalledTimes(2);
    expect(wallet.advanceQbitRecoveryMigration).toHaveBeenCalledWith(2, 'ab'.repeat(32));
    expect(wallet.prepareQbitRecoveryMigration).toHaveBeenCalledWith(2, undefined, 'ab'.repeat(32));
  });

  it('shows known on-chain usage as none when no usage was observed', async () => {
    const zeroSigSeedOnlyState = { ...seedOnlyState, knownOnChainSignatures: 0 };
    const zeroSigMigratingState = { ...migratingState, knownOnChainSignatures: 0 };
    wallet.getQbitRecoveryState.mockResolvedValue(zeroSigSeedOnlyState);
    wallet.createQbitRecoveryMigrationWallet.mockResolvedValue(zeroSigMigratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(zeroSigMigratingState);
    wallet.prepareQbitRecoveryMigration.mockResolvedValue({
      state: zeroSigMigratingState,
      toSignDatas: [
        {
          ...toSignData,
          signatureBudget: {
            ...toSignData.signatureBudget,
            restoredFloorRisk: { ...toSignData.signatureBudget.restoredFloorRisk, knownOnChainSignatures: 0 }
          }
        }
      ]
    });

    render(<QbitRecoveryMigrationScreen />);

    fireEvent.click(await screen.findByTestId('create-fresh-seed'));
    fireEvent.click(await screen.findByTestId('confirm-fresh-seed-backup'));

    expect((await screen.findByTestId('qbit-recovery-known-onchain-usage')).textContent).toBe(
      'qbit_known_onchain_usage_none'
    );
    expect(screen.getByTestId('qbit-recovery-review-intro')).toBeTruthy();
  });

  it('returns from verification to the same generated seed on header back', async () => {
    render(<QbitRecoveryMigrationScreen />);

    fireEvent.click(await screen.findByTestId('create-fresh-seed'));
    expect(await screen.findByTestId('confirm-fresh-seed-backup')).toBeTruthy();

    fireEvent.click(screen.getByTestId('header-back'));

    // Back lands on the seed display, still holding the phrase generated
    // before verification — not a freshly minted one, and not the homepage.
    const seedScreen = await screen.findByTestId('create-fresh-seed');
    expect(seedScreen.textContent).toBe('fresh seed words stay inside the encrypted wallet handoff');
    expect(navigate).not.toHaveBeenCalled();
    expect(wallet.createQbitRecoveryMigrationWallet).not.toHaveBeenCalled();
    // Returning to the seed display is loss-free, so no restart warning.
    expect(screen.queryByTestId('qbit-recovery-restart-warning')).toBeNull();
  });

  it('asks for confirmation before leaving the seed display and cancel stays', async () => {
    render(<QbitRecoveryMigrationScreen />);

    fireEvent.click(await screen.findByTestId('create-fresh-seed'));
    await screen.findByTestId('confirm-fresh-seed-backup');
    fireEvent.click(screen.getByTestId('header-back'));
    await screen.findByTestId('create-fresh-seed');

    fireEvent.click(screen.getByTestId('header-back'));

    // Leaving the seed display would discard the shown phrase, so the exit
    // needs explicit confirmation instead of silently navigating away.
    expect(await screen.findByTestId('qbit-recovery-restart-warning')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_back_restart_warning')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_back_new_seed_warning')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('qbit-recovery-restart-cancel'));
    expect(screen.queryByTestId('qbit-recovery-restart-warning')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    // The flow stays on the seed display with the same held phrase.
    expect(screen.getByTestId('create-fresh-seed').textContent).toBe(
      'fresh seed words stay inside the encrypted wallet handoff'
    );
  });

  it('leaves the flow only after the restart warning is confirmed', async () => {
    render(<QbitRecoveryMigrationScreen />);

    await screen.findByTestId('create-fresh-seed');
    fireEvent.click(screen.getByTestId('header-back'));
    expect(await screen.findByTestId('qbit-recovery-restart-warning')).toBeTruthy();

    fireEvent.click(screen.getByTestId('qbit-recovery-restart-confirm'));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('#back');
    expect(screen.queryByTestId('qbit-recovery-restart-warning')).toBeNull();
  });

  it('skips the fresh-seed step when a prior migration recorded a reusable destination', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue({
      ...seedOnlyState,
      migrationDestinationReusable: true
    });

    render(<QbitRecoveryMigrationScreen />);

    expect(await screen.findByTestId('qbit-recovery-review-confirmation')).toBeTruthy();
    expect(wallet.beginQbitRecoveryMigrationToExistingDestination).toHaveBeenCalledWith({
      sourceKeyringIndex: 2,
      sourceAnchorPubkey: 'ab'.repeat(32)
    });
    expect(wallet.createQbitRecoveryMigrationWallet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('create-fresh-seed')).toBeNull();
  });

  it('falls back to the fresh-seed flow when the recorded destination no longer resolves', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue({
      ...seedOnlyState,
      migrationDestinationReusable: true
    });
    wallet.beginQbitRecoveryMigrationToExistingDestination.mockRejectedValue(
      Object.assign(new Error('Qbit recovery migration destination is unavailable'), {
        code: ErrorCodes.QBIT_RECOVERY_DESTINATION_UNAVAILABLE
      })
    );

    render(<QbitRecoveryMigrationScreen />);

    expect(await screen.findByTestId('create-fresh-seed')).toBeTruthy();
    expect(wallet.prepareQbitRecoveryMigration).not.toHaveBeenCalled();
  });

  it('keeps a transient reuse failure out of the fresh-seed flow', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue({
      ...seedOnlyState,
      migrationDestinationReusable: true
    });
    // Begin can fail after the migration durably started (for example the
    // state read behind it). A fresh seed backed up now could never become
    // the destination, so the screen must surface a retryable error instead.
    wallet.beginQbitRecoveryMigrationToExistingDestination.mockRejectedValue(
      new Error('recovery state re-read failed after begin')
    );

    render(<QbitRecoveryMigrationScreen />);

    expect(await screen.findByTestId('qbit-recovery-error')).toBeTruthy();
    expect(screen.queryByTestId('create-fresh-seed')).toBeNull();
    expect(wallet.createQbitRecoveryMigrationWallet).not.toHaveBeenCalled();
  });

  it('reviews the exact account mapping for structure-preserving sweeps', async () => {
    const structuredState = {
      ...migratingState,
      migration: {
        ...migratingState.migration,
        plans: [
          {
            ...migratingState.migration.plans[0],
            sourceIndex: 0,
            destinationIndex: 0
          },
          {
            ...migratingState.migration.plans[0],
            id: 'plan-2',
            sourceAddress: 'qbrt1zrecovered2',
            destinationAddress: 'qbrt1zfreshdestination2',
            sourceIndex: 2,
            destinationIndex: 2
          }
        ]
      }
    };
    wallet.getQbitRecoveryState.mockResolvedValue(structuredState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(structuredState);
    wallet.prepareQbitRecoveryMigration.mockReset().mockResolvedValue({
      state: structuredState,
      toSignDatas: [
        toSignData,
        {
          ...toSignData,
          qbitRecoveryMigration: {
            ...toSignData.qbitRecoveryMigration,
            planId: 'plan-2',
            destinationAddress: 'qbrt1zfreshdestination2',
            destinationIndex: 2
          }
        }
      ]
    });

    render(<QbitRecoveryMigrationScreen />);

    const mappings = await screen.findAllByTestId('qbit-recovery-account-mapping');
    expect(mappings.map((mapping) => mapping.textContent)).toEqual([
      'qbit_recovery_account_mapping_label:1,1qbrt1z...nation',
      'qbit_recovery_account_mapping_label:3,3qbrt1z...ation2'
    ]);
    // The single shared-destination line is replaced by the mapping.
    expect(screen.queryByTestId('qbit-recovery-destination')).toBeNull();

    // Every mapped destination exposes its own reveal/copy actions.
    expect(screen.getAllByTestId('qbit-recovery-copy-address')).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId('qbit-recovery-reveal-address')[1]);
    expect(screen.getByTestId('qbit-recovery-full-address').textContent).toBe('qbrt1zfreshdestination2');
  });

  it('names a source the migration could not plan and how to free it (#344)', async () => {
    const pendingState = {
      ...migratingState,
      migration: {
        ...migratingState.migration,
        plans: [{ ...migratingState.migration.plans[0], status: 'confirmed', txid: 'aa'.repeat(32) }]
      }
    };
    wallet.getQbitRecoveryState.mockResolvedValue(pendingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(pendingState);
    wallet.prepareQbitRecoveryMigration.mockReset().mockResolvedValue({
      state: pendingState,
      toSignDatas: [],
      deferredSources: [{ address: 'qbrt1zminerpayout', reason: 'history_too_large', maxTransactions: 10_000 }]
    });

    render(<QbitRecoveryMigrationScreen />);

    const notice = await screen.findByTestId('qbit-recovery-deferred-sources');
    expect(screen.getByText('qbit_recovery_pending_title')).toBeTruthy();
    expect(notice.textContent).toContain('qbrt1zminerpayout');
    expect(notice.textContent).toContain(`qbit_recovery_deferred_history_too_large:${(10_000).toLocaleString()}`);

    // A pass that returns before reading the sources keeps the notice; one
    // that reads them and defers nothing clears it.
    wallet.prepareQbitRecoveryMigration.mockResolvedValueOnce({ state: pendingState, toSignDatas: [] });
    fireEvent.click(screen.getByTestId('qbit-recovery-check-status-button'));
    await waitFor(() => expect(wallet.prepareQbitRecoveryMigration).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('qbit-recovery-deferred-sources')).toBeTruthy();
    wallet.prepareQbitRecoveryMigration.mockResolvedValueOnce({
      state: pendingState,
      toSignDatas: [],
      deferredSources: []
    });
    fireEvent.click(await screen.findByTestId('qbit-recovery-check-status-button'));
    await waitFor(() => expect(screen.queryByTestId('qbit-recovery-deferred-sources')).toBeNull());
  });

  it('names a source whose history the wallet could not read in full', async () => {
    const pendingState = {
      ...migratingState,
      migration: {
        ...migratingState.migration,
        plans: [{ ...migratingState.migration.plans[0], status: 'confirmed', txid: 'aa'.repeat(32) }]
      }
    };
    wallet.getQbitRecoveryState.mockResolvedValue(pendingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(pendingState);
    wallet.prepareQbitRecoveryMigration.mockReset().mockResolvedValue({
      state: pendingState,
      toSignDatas: [],
      deferredSources: [
        { address: 'qbrt1zminerpayout', reason: 'history_too_large', maxTransactions: 10_000 },
        { address: 'qbrt1zbusypayout', reason: 'history_incomplete' }
      ]
    });

    render(<QbitRecoveryMigrationScreen />);

    const notice = await screen.findByTestId('qbit-recovery-deferred-sources');
    expect(notice.textContent).toContain('qbrt1zbusypayout');
    expect(notice.textContent).toContain('qbit_recovery_deferred_history_incomplete');
    // Each source keeps its own reason.
    expect(notice.textContent).toContain(`qbit_recovery_deferred_history_too_large:${(10_000).toLocaleString()}`);
    expect(notice.textContent?.match(/qbit_recovery_deferred_history_/g)).toHaveLength(2);
  });

  it('reviews a source swept in several batches as one account mapping', async () => {
    const batchedState = {
      ...migratingState,
      migration: {
        ...migratingState.migration,
        plans: [
          { ...migratingState.migration.plans[0], sourceIndex: 0, destinationIndex: 0 },
          { ...migratingState.migration.plans[0], id: 'plan-1-batch-2', sourceIndex: 0, destinationIndex: 0 }
        ]
      }
    };
    wallet.getQbitRecoveryState.mockResolvedValue(batchedState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(batchedState);
    wallet.prepareQbitRecoveryMigration.mockReset().mockResolvedValue({
      state: batchedState,
      toSignDatas: [
        toSignData,
        {
          ...toSignData,
          qbitRecoveryMigration: { ...toSignData.qbitRecoveryMigration, planId: 'plan-1-batch-2' }
        }
      ]
    });

    render(<QbitRecoveryMigrationScreen />);

    const mappings = await screen.findAllByTestId('qbit-recovery-account-mapping');
    expect(mappings.map((mapping) => mapping.textContent)).toEqual([
      'qbit_recovery_account_mapping_label:1,1qbrt1z...nation'
    ]);
  });

  it('presents every funded per-account destination after completion', async () => {
    const migratedStructuredState = {
      ...migratingState,
      status: 'migrated',
      migration: {
        ...migratingState.migration,
        plans: [
          {
            ...migratingState.migration.plans[0],
            status: 'confirmed',
            txid: 'aa'.repeat(32),
            sourceIndex: 0,
            destinationIndex: 0
          },
          {
            ...migratingState.migration.plans[0],
            id: 'plan-2',
            sourceAddress: 'qbrt1zrecovered2',
            destinationAddress: 'qbrt1zfreshdestination2',
            status: 'confirmed',
            txid: 'bb'.repeat(32),
            sourceIndex: 2,
            destinationIndex: 2
          }
        ]
      }
    };
    wallet.getQbitRecoveryState.mockResolvedValue(migratedStructuredState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(migratedStructuredState);

    render(<QbitRecoveryMigrationScreen />);

    await screen.findByTestId('qbit-recovery-complete');
    // Funds landed account-to-account, so the anchor-only line would show an
    // address that received nothing; every funded mapping is listed instead.
    const destinations = screen.getAllByTestId('qbit-recovery-complete-destination');
    expect(destinations.map((destination) => destination.textContent)).toEqual([
      'qbit_recovery_account_mapping:1,1,qbrt1zfreshdestination',
      'qbit_recovery_account_mapping:3,3,qbrt1zfreshdestination2'
    ]);
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    fireEvent.click(screen.getAllByTestId('qbit-recovery-copy-destination')[1]);
    expect(vi.mocked(copyToClipboard)).toHaveBeenCalledWith('qbrt1zfreshdestination2');
  });

  it('resumes a persisted migration when destination activation reports an error', async () => {
    wallet.getQbitRecoveryState.mockResolvedValueOnce(seedOnlyState).mockResolvedValue(migratingState);
    wallet.createQbitRecoveryMigrationWallet.mockRejectedValue(
      new Error('active account refresh failed after destination persistence')
    );

    render(<QbitRecoveryMigrationScreen />);

    fireEvent.click(await screen.findByTestId('create-fresh-seed'));
    fireEvent.click(await screen.findByTestId('confirm-fresh-seed-backup'));

    expect((await screen.findByTestId('qbit-recovery-destination')).textContent).toBe(
      'qbit_recovery_destination_labelqbrt1z...nation'
    );
    expect(wallet.getQbitRecoveryState).toHaveBeenCalledTimes(2);
    expect(wallet.advanceQbitRecoveryMigration).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('create-fresh-seed')).toBeNull();
  });

  it('keeps the user in review when a provider re-render supplies a new t identity', async () => {
    vi.mocked(useI18n).mockImplementation(
      () =>
        ({
          t: (key: string, substitutions?: string | string[]) =>
            substitutions === undefined
              ? key
              : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
        } as any)
    );
    wallet.getQbitRecoveryState.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(migratingState);

    const { rerender } = render(<QbitRecoveryMigrationScreen />);

    fireEvent.click(await screen.findByTestId('qbit-recovery-review-confirmation'));
    const signButton = screen.getByTestId('qbit-recovery-sign-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(false);
    expect(wallet.advanceQbitRecoveryMigration).toHaveBeenCalledTimes(1);

    rerender(<QbitRecoveryMigrationScreen />);

    const confirmation = screen.getByTestId('qbit-recovery-review-confirmation') as HTMLInputElement;
    expect(confirmation.checked).toBe(true);
    await waitFor(() => expect(wallet.advanceQbitRecoveryMigration).toHaveBeenCalledTimes(1));
    expect(wallet.prepareQbitRecoveryMigration).toHaveBeenCalledTimes(1);
  });

  it('runs a single confirm/sign loop when the sign button is double-clicked', async () => {
    const toastError = vi.fn();
    vi.mocked(useTools).mockReturnValue({ toastError } as any);
    wallet.getQbitRecoveryState.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(migratingState);

    render(<QbitRecoveryMigrationScreen />);

    fireEvent.click(await screen.findByTestId('qbit-recovery-review-confirmation'));
    const signButton = screen.getByTestId('qbit-recovery-sign-button') as HTMLButtonElement;
    // Both clicks dispatch before React re-renders into the loading stage
    // (nested act defers the flush), so only the synchronous in-flight lock
    // can stop a duplicate loop from re-consuming the challenge and toasting
    // a bogus migration error.
    act(() => {
      fireEvent.click(signButton);
      fireEvent.click(signButton);
    });

    await waitFor(() => expect(wallet.advanceQbitRecoveryMigration).toHaveBeenCalledTimes(2));
    expect(wallet.confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(1);
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('releases retained review challenges when leaving review without signing', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(migratingState);

    const { unmount } = render(<QbitRecoveryMigrationScreen />);

    await screen.findByTestId('qbit-recovery-review-confirmation');
    expect(wallet.releaseQbitRestoredFloorSigningChallenges).not.toHaveBeenCalled();

    // Abandoning the review must free its retained challenges instead of
    // pinning them against the global capacity for the full TTL.
    unmount();

    expect(wallet.releaseQbitRestoredFloorSigningChallenges).toHaveBeenCalledWith([
      'migration-challenge'
    ]);
  });

  it('renders the localized protected-asset instruction selected by stable code', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(migratingState);
    // Background errors cross the port as plain objects; the code is the
    // contract, so the human-readable wording must not matter to the UI.
    wallet.prepareQbitRecoveryMigration.mockReset().mockRejectedValue({
      message: 'background wording that must never be shown',
      code: ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS
    });

    render(<QbitRecoveryMigrationScreen />);

    expect(await screen.findByText('qbit_recovery_protected_assets_error')).toBeTruthy();
    expect(screen.queryByText('background wording that must never be shown')).toBeNull();
  });

  it('hides unknown internal errors behind the generic localized message', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(migratingState);
    wallet.prepareQbitRecoveryMigration.mockReset().mockRejectedValue(new Error('internal migration detail'));

    render(<QbitRecoveryMigrationScreen />);

    expect(await screen.findByText('qbit_recovery_error_body')).toBeTruthy();
    expect(screen.queryByText('internal migration detail')).toBeNull();
    expect(screen.queryByText('qbit_recovery_protected_assets_error')).toBeNull();
  });

  it('shows a step code and copyable details for an unknown failure', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockResolvedValue(migratingState);
    wallet.prepareQbitRecoveryMigration
      .mockReset()
      .mockRejectedValue({ message: `invalid qbit address stats for qbt1z${'a'.repeat(58)}` });

    render(<QbitRecoveryMigrationScreen />);

    const code = await screen.findByTestId('qbit-recovery-error-code');
    expect(code.textContent).toMatch(/^qbit_recovery_error_code_label QRM-PREP-[0-9A-F]{8}$/);
    // Details stay collapsed until asked for.
    expect(screen.queryByTestId('qbit-recovery-error-details')).toBeNull();

    fireEvent.click(screen.getByTestId('qbit-recovery-error-details-toggle'));
    const details = screen.getByTestId('qbit-recovery-error-details').textContent ?? '';
    expect(details).toContain('Step: prepare');
    expect(details).toContain('Message: invalid qbit address stats for qbt1za…aaaa');
    expect(details).toContain('Network: QBIT_TESTNET4');
    expect(details).not.toContain('a'.repeat(58));

    fireEvent.click(screen.getByTestId('qbit-recovery-error-copy-details'));
    expect(copyToClipboard).toHaveBeenCalledWith(details);

    fireEvent.click(screen.getByTestId('qbit-recovery-error-details-toggle'));
    expect(screen.queryByTestId('qbit-recovery-error-details')).toBeNull();
  });

  it('attributes the code to the wallet call that failed', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue(migratingState);
    wallet.advanceQbitRecoveryMigration.mockReset().mockRejectedValue(new Error('broadcast rejected'));

    render(<QbitRecoveryMigrationScreen />);

    const code = await screen.findByTestId('qbit-recovery-error-code');
    expect(code.textContent).toContain('QRM-ADV-');
    expect(wallet.prepareQbitRecoveryMigration).not.toHaveBeenCalled();
  });

  it('codes a failed reuse of an existing destination as the begin step', async () => {
    wallet.getQbitRecoveryState.mockResolvedValue({ ...seedOnlyState, migrationDestinationReusable: true });
    wallet.beginQbitRecoveryMigrationToExistingDestination.mockReset().mockRejectedValue({
      message: 'Qbit recovery keyring is unavailable'
    });

    render(<QbitRecoveryMigrationScreen />);

    const code = await screen.findByTestId('qbit-recovery-error-code');
    expect(code.textContent).toContain('QRM-BEGIN-');
  });

  it('refreshes wallet activity during the grace period and locks at the ten-minute deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(0);
    render(<QbitRecoveryMigrationScreen />);
    await flushInitialLoad();
    expect(screen.getByTestId('create-fresh-seed')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    });
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(59);
    expect(wallet.lockWallet).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(59);
    // The last refresh re-armed the background lock timer for the full
    // configured auto-lock duration, so the deadline is enforced with an
    // explicit lock instead of waiting out that timer.
    expect(wallet.lockWallet).toHaveBeenCalledTimes(1);
  });

  it('stops refreshing wallet activity when wall time moves backward', async () => {
    vi.useFakeTimers();
    let wallClockTime = 100_000;
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(Date, 'now').mockImplementation(() => wallClockTime);
    render(<QbitRecoveryMigrationScreen />);
    await flushInitialLoad();

    act(() => {
      wallClockTime += 10 * 1000;
      vi.advanceTimersByTime(10 * 1000);
    });
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);

    act(() => {
      wallClockTime -= 1;
      vi.advanceTimersByTime(10 * 1000);
      wallClockTime += 60 * 1000;
      vi.advanceTimersByTime(60 * 1000);
    });
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);
    // The backward jump only stops refreshing; the scheduled lock still ends
    // the grace period at the monotonic deadline.
    expect(wallet.lockWallet).not.toHaveBeenCalled();
  });

  it('stops refreshing wallet activity when the screen unmounts', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<QbitRecoveryMigrationScreen />);
    await flushInitialLoad();

    act(() => {
      vi.advanceTimersByTime(10 * 1000);
    });
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000);
    });
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);
    // Leaving the screen ends the seed exposure, so the deadline lock is
    // cancelled with it and normal auto-lock behavior resumes.
    expect(wallet.lockWallet).not.toHaveBeenCalled();
  });

  it('keeps a rejected keepalive refresh from becoming an unhandled rejection', async () => {
    // Without the catch inside the keepalive, this rejection surfaces as an
    // unhandled error and fails the test file.
    wallet.setLastActiveTime.mockRejectedValue(new Error('wallet is locking'));
    vi.useFakeTimers();
    render(<QbitRecoveryMigrationScreen />);
    await flushInitialLoad();

    await act(async () => {
      vi.advanceTimersByTime(10 * 1000);
      await Promise.resolve();
    });
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);
  });
});
