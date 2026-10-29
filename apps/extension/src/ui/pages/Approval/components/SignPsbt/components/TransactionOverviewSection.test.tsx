import type { CSSProperties, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { useI18n, useQbitUnit } from '@qbit/wallet-state';

import TransactionOverviewSection from './TransactionOverviewSection';

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
    onClick?: (e: unknown) => void;
    'data-testid'?: string;
  }) => React.createElement('div', { style, onClick, 'data-testid': dataTestId }, children);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  const Icon = () => null;

  return {
    Card: Container,
    Column: Container,
    Grid: Container,
    Icon,
    Row: Container,
    Text,
    Tooltip: Container
  };
});

vi.mock('@/ui/utils', () => ({
  amountToSatoshis: (val: unknown) => Number(val)
}));

vi.mock('@qbit/wallet-state', () => ({
  useI18n: vi.fn(),
  useQbitUnit: vi.fn()
}));

const decodedPsbt = {
  isCompleted: true,
  fee: 3860,
  feeRate: 1,
  recommendedFeeRate: 1,
  shouldWarnFeeRate: false
} as any;

function toSignDataWithBudget() {
  return {
    psbtHex: '00',
    toSignInputs: [],
    signatureBudget: {
      required: 2,
      cached: 1,
      remainingBefore: 100,
      remainingAfter: 98,
      limit: 1073741824
    }
  } as any;
}

describe('TransactionOverviewSection signature budget row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
  });

  it('shows the exact preflighted P2MR signature-budget impact', () => {
    render(
      <TransactionOverviewSection decodedPsbt={decodedPsbt} networkFee={0.0000386} toSignData={toSignDataWithBudget()} />
    );

    expect(screen.getByTestId('psbt-signature-budget')).toBeTruthy();
    expect(screen.getByText('0.0000386 QBT')).toBeTruthy();
    expect(screen.getByText('1 bits/vB')).toBeTruthy();
    expect(screen.getByTestId('psbt-network-fee-base-units').textContent).toBe('Exact fee: 3860 bits');
    expect(screen.getByText('Signatures: 2 new • 1 cached')).toBeTruthy();
    expect(screen.getByText('Signature budget: 100 before, 98 after')).toBeTruthy();
  });

  it('renders no budget row when the approval has no preflighted budget', () => {
    render(
      <TransactionOverviewSection
        decodedPsbt={decodedPsbt}
        networkFee={0.0000386}
        toSignData={{ psbtHex: '00', toSignInputs: [] } as any}
      />
    );

    expect(screen.queryByTestId('psbt-signature-budget')).toBeNull();
  });

  it('shows a restored-floor lower bound without an exact remaining budget', () => {
    const toSignData = toSignDataWithBudget();
    toSignData.signatureBudget.restoredFloorRisk = {
      recoveryStatus: 'seed-only-restored',
      counterConfidence: 'chain-floor-only',
      knownOnChainSignatures: 42,
      challengeId: 'challenge-42'
    };

    render(
      <TransactionOverviewSection
        decodedPsbt={decodedPsbt}
        networkFee={0.0000386}
        toSignData={toSignData}
      />
    );

    expect(screen.getByText('qbit_known_onchain_usage_lower_bound:42+')).toBeTruthy();
    expect(screen.queryByText('Signature budget: 100 before, 98 after')).toBeNull();
  });

  it('says when the fee was not compared with recommended rates (#271)', () => {
    render(
      <TransactionOverviewSection
        decodedPsbt={{
          ...decodedPsbt,
          spendSummary: { feeAssessment: { fee: 3860, feeRate: 1, amount: 10_000, reasons: [] } }
        }}
        networkFee={0.0000386}
      />
    );
    expect(screen.getByTestId('psbt-fee-recommendation-unavailable').textContent).toBe(
      'fee_warning_recommendation_unavailable'
    );

    cleanup();
    render(
      <TransactionOverviewSection
        decodedPsbt={{
          ...decodedPsbt,
          spendSummary: {
            feeAssessment: { fee: 3860, feeRate: 1, amount: 10_000, recommendedFeeRate: 1, reasons: [] }
          }
        }}
        networkFee={0.0000386}
      />
    );
    expect(screen.queryByTestId('psbt-fee-recommendation-unavailable')).toBeNull();
  });
});

describe('TransactionOverviewSection finalize decision, nLockTime and version (#13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
  });

  /** A website's signPsbt request, as the background prepared it. */
  function websiteToSignData(autoFinalized: boolean | undefined) {
    return {
      psbtHex: '00',
      toSignInputs: [],
      providerContext: { method: 'signPsbt', chain: 'QBIT_REGTEST' },
      ...(autoFinalized === undefined ? {} : { autoFinalized })
    } as any;
  }

  function renderOverview(overrides: object, toSignData?: object) {
    return render(
      <TransactionOverviewSection
        decodedPsbt={{ ...decodedPsbt, ...overrides }}
        networkFee={0.0000386}
        toSignData={toSignData as any}
      />
    );
  }

  it('says the site gets a finalized PSBT it can broadcast', () => {
    renderOverview({}, websiteToSignData(true));
    expect(screen.getByTestId('psbt-finalize-decision').textContent).toBe('psbt_finalized');
  });

  it('says the PSBT comes back signed but not finalized, for other signers', () => {
    renderOverview({}, websiteToSignData(false));
    expect(screen.getByTestId('psbt-finalize-decision').textContent).toBe('psbt_not_finalized');
  });

  it('shows the decision signing carries out when the request leaves it unset', () => {
    renderOverview({}, websiteToSignData(undefined));
    expect(screen.getByTestId('psbt-finalize-decision').textContent).toBe('psbt_finalized');
  });

  it('shows the decision for a PSBT whose fee is unknown, without the fee', () => {
    renderOverview({ isCompleted: false, locktime: 0, version: 2 }, websiteToSignData(false));
    expect(screen.getByTestId('psbt-finalize-decision').textContent).toBe('psbt_not_finalized');
    expect(screen.getByTestId('psbt-locktime').textContent).toBe('psbt_locktime_none');
    expect(screen.queryByTestId('psbt-network-fee-base-units')).toBeNull();
  });

  it('shows no decision for a PSBT the wallet built and broadcasts itself', () => {
    renderOverview({}, { psbtHex: '00', toSignInputs: [], autoFinalized: true });
    expect(screen.queryByTestId('psbt-finalize-decision')).toBeNull();

    cleanup();
    // A website's sendQbit: the wallet built the PSBT and broadcasts it.
    renderOverview({}, { ...websiteToSignData(true), qbitSendBroadcastClaim: { txid: 'aa' } });
    expect(screen.queryByTestId('psbt-finalize-decision')).toBeNull();
  });

  it('shows the version', () => {
    renderOverview({ version: 3, locktime: 0 });
    expect(screen.getByTestId('psbt-tx-version').textContent).toBe('3');
  });

  it('shows no lock for an nLockTime of 0', () => {
    renderOverview({ locktime: 0, version: 2 });
    expect(screen.getByTestId('psbt-locktime').textContent).toBe('psbt_locktime_none');
    expect(screen.getByTestId('psbt-locktime-raw').textContent).toBe('nLockTime 0');
  });

  it('shows an nLockTime below 500,000,000 as a block height', () => {
    renderOverview({ locktime: 499_999_999, version: 2, inputInfos: [{ sequence: 0xfffffffd }] });
    expect(screen.getByTestId('psbt-locktime').textContent).toBe('psbt_locktime_block:499999999');
    expect(screen.getByTestId('psbt-locktime-raw').textContent).toBe('nLockTime 499999999');
  });

  it('shows an nLockTime from 500,000,000 as a time', () => {
    renderOverview({ locktime: 500_000_000, version: 2, inputInfos: [{ sequence: 0xfffffffd }] });
    expect(screen.getByTestId('psbt-locktime').textContent).toBe('psbt_locktime_time:1985-11-05 00:53:20 UTC');

    cleanup();
    renderOverview({ locktime: 1_767_225_600, version: 2, inputInfos: [{ sequence: 0xfffffffe }] });
    expect(screen.getByTestId('psbt-locktime').textContent).toBe('psbt_locktime_time:2026-01-01 00:00:00 UTC');
    expect(screen.getByTestId('psbt-locktime-raw').textContent).toBe('nLockTime 1767225600');
  });

  it('shows no lock when every input is final, so nLockTime is not enforced', () => {
    renderOverview({
      locktime: 900_000,
      version: 2,
      inputInfos: [{ sequence: 0xffffffff }, { sequence: 0xffffffff }]
    });
    expect(screen.getByTestId('psbt-locktime').textContent).toBe('psbt_locktime_none');
    expect(screen.getByTestId('psbt-locktime-raw').textContent).toBe('psbt_locktime_not_enforced:900000');

    cleanup();
    // One input that is not final enforces it.
    renderOverview({
      locktime: 900_000,
      version: 2,
      inputInfos: [{ sequence: 0xffffffff }, { sequence: 0xfffffffe }]
    });
    expect(screen.getByTestId('psbt-locktime').textContent).toBe('psbt_locktime_block:900000');
  });

  it('shows no nLockTime or version a review did not decode', () => {
    renderOverview({});
    expect(screen.queryByTestId('psbt-locktime')).toBeNull();
    expect(screen.queryByTestId('psbt-tx-version')).toBeNull();
  });
});
