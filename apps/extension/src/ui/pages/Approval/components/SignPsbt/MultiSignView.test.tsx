import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  useCurrentAccountCapabilities,
  useI18n,
  useQbitUnit,
  useSignPsbtLogic,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import SignPsbt from './index';

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
    icon,
    disabled,
    onClick,
    'data-testid': dataTestId
  }: {
    text?: string;
    icon?: string;
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
  }) => React.createElement('button', { disabled, onClick, 'data-testid': dataTestId, 'data-icon': icon }, text);
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);
  return {
    Button,
    Card: Container,
    Checkbox: () => null,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header: Container,
    Icon: Container,
    Input: () => null,
    Layout: Container,
    Row: Container,
    Text
  };
});

vi.mock('@/ui/components/AutoFitVirtualList', async () => {
  const React = await import('react');
  return {
    AutoFitVirtualList: ({ data, children }: { data: unknown[]; children: (item: any, index: number) => ReactNode }) =>
      React.createElement(
        'div',
        null,
        data.map((item, index) => React.createElement('div', { key: index }, children(item, index)))
      )
  };
});
vi.mock('@/ui/components/ColdWallet/ColdWalletSignPsbt', () => ({ default: () => null }));
vi.mock('@/ui/components/PhishingDetection', () => ({ PhishingDetection: () => null }));
vi.mock('@/ui/components/QbitRestoredFloorWarning', () => ({ QbitRestoredFloorWarning: () => null }));
vi.mock('@/ui/components/SignPsbtWithRisksPopover', () => ({
  SignPsbtWithRisksPopover: () => null,
  getRiskContentKey: (type: number) => ({ title: `risk_title_${type}`, description: `risk_description_${type}` })
}));
vi.mock('@/ui/components/WebsiteBar', () => ({ default: () => null }));
vi.mock('@/ui/theme/colors', () => ({ colors: { border: '', surface: '' } }));
vi.mock('@/ui/theme/font', () => ({ fontSizes: { xs: 12, sm: 14, xxxl: 32 } }));
vi.mock('@/ui/utils', () => ({ walletErrorMessage: (error: unknown) => String(error) }));
vi.mock('@qbit/base-utils', () => ({ numUtils: { satoshisToAmount: () => '0' } }));
vi.mock('@qbit/wallet-shared', () => ({
  AccountSignMethod: { Local: 'local', ColdWallet: 'coldWallet', External: 'external', None: 'none' }
}));
vi.mock('@qbit/wallet-state', () => ({
  useCurrentAccountCapabilities: vi.fn(),
  useI18n: vi.fn(),
  useQbitUnit: vi.fn(),
  useSignPsbtLogic: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

vi.mock('./components/ActionOverviewSection', () => ({ default: () => null }));
vi.mock('./components/InputsList', () => ({ InputsList: () => null }));
vi.mock('./components/MultiSignDisclaimerModal', () => ({ default: () => null }));
vi.mock('./components/MultiSignRisksPopover', async () => {
  const React = await import('react');
  return {
    default: ({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) =>
      React.createElement(
        'div',
        { 'data-testid': 'multisign-risks-popover' },
        React.createElement('button', { onClick: onConfirm, 'data-testid': 'batch-risk-confirm' }),
        React.createElement('button', { onClick: onClose, 'data-testid': 'batch-risk-close' })
      )
  };
});
vi.mock('./components/OutputsList', () => ({ OutputsList: () => null }));
vi.mock('./components/PsbtDataSection', () => ({ default: () => null }));
vi.mock('./components/Section', () => ({
  SignPsbtSection: ({ children }: { children?: ReactNode }) => children
}));
vi.mock('./components/TransactionOverviewSection', () => ({ default: () => null }));
vi.mock('../ProviderContextCard', () => ({ default: () => null }));
vi.mock('../WebsiteCheckWarning', () => ({ default: () => null }));

const session = { origin: 'https://approval.example', icon: '', name: 'Approval' };
const HIGH_FEE_RATE = 4;
const UNRECOGNISED_OUTPUT = 5;

const toSignDatas = [
  { psbtHex: 'clean-psbt', toSignInputs: [] },
  { psbtHex: 'high-fee-psbt', toSignInputs: [] },
  { psbtHex: 'unrecognised-output-psbt', toSignInputs: [] }
];

function psbtInfo(risks: { type: number; level: string }[]) {
  return {
    inputCount: 1,
    outputCount: 2,
    feeRate: '1.00',
    fee: 100,
    totalInput: 10_000,
    isCompleted: true,
    hasSighashNone: false,
    parseError: false,
    risks
  };
}

const items = [
  psbtInfo([]),
  psbtInfo([{ type: HIGH_FEE_RATE, level: 'warning' }]),
  psbtInfo([{ type: UNRECOGNISED_OUTPUT, level: 'danger' }])
];
const summary = {
  totalFee: 300,
  totalInput: 30_000,
  completedCount: 3,
  hasSighashNone: false,
  parseErrorCount: 0,
  items,
  account: 'qbrt1zaccount',
  chain: 'QBIT_REGTEST'
};

function multiSignLogic(overrides: Record<string, unknown> = {}) {
  return {
    showLoading: false,
    isPsbtRiskPopoverVisible: false,
    t: (key: string, substitution?: string) => (substitution === undefined ? key : `${key}(${substitution})`),
    session,
    toSignDatas,
    currentToSignData: undefined,
    currentDecodedPsbt: undefined,
    isColdWalletSigning: false,
    showMultiSignView: true,
    disclaimerVisible: false,
    localPsbtSummary: summary,
    batchRiskReview: null,
    batchRiskIndexes: [1, 2],
    decodeError: false,
    websiteCheckStatus: 'clear',
    websiteCheckWarning: '',
    isAllSigned: false,
    signedCount: 0,
    multiSignList: items.map((info, index) => ({
      index,
      buttonText: 'view',
      buttonPreset: 'primary',
      psbtInfo: info,
      onClick: vi.fn()
    })),
    isValid: false,
    networkFee: '0',
    hasRisk: false,
    showFeeSection: false,
    isBlocked: false,
    allowQuickMultiSign: true,
    onClickBack: vi.fn(),
    onClickSign: vi.fn(),
    onRetryDecode: vi.fn(),
    onRetryWebsiteCheck: vi.fn(),
    onRejectApprovalError: vi.fn(),
    onQuickMultiSign: vi.fn(),
    onTryMultiSign: vi.fn(),
    onTrustSite: vi.fn(),
    onColdWalletSigningSuccess: vi.fn(),
    onColdWalletSigningBack: vi.fn(),
    onRiskPopoverConfirm: vi.fn(),
    onRiskPopoverClose: vi.fn(),
    onDisclaimerModalClose: vi.fn(),
    onBatchRiskConfirm: vi.fn(),
    onBatchRiskClose: vi.fn(),
    ...overrides
  } as unknown as ReturnType<typeof useSignPsbtLogic>;
}

function renderMultiSign(logic: ReturnType<typeof useSignPsbtLogic>) {
  vi.mocked(useSignPsbtLogic).mockReturnValue(logic);
  return render(<SignPsbt params={{ data: { toSignDatas }, session } as any} />);
}

describe('SignPsbt quick multi-sign of a flagged local batch (#367)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCurrentAccountCapabilities).mockReturnValue({ signMethod: 'local' } as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBT' as any);
    vi.mocked(useTools).mockReturnValue({ toastError: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({} as any);
  });

  afterEach(cleanup);

  it('marks each flagged transaction and names them in the batch summary', () => {
    renderMultiSign(multiSignLogic());

    expect(screen.queryByTestId('multisign-transaction-risk-0')).toBeNull();
    expect(screen.getByTestId('multisign-transaction-risk-1').textContent).toBe(`⚠ risk_title_${HIGH_FEE_RATE}`);
    expect(screen.getByTestId('multisign-transaction-risk-2').textContent).toBe(`⚠ risk_title_${UNRECOGNISED_OUTPUT}`);
    expect(screen.getByTestId('multisign-flagged-transactions').textContent).toBe(
      'multisign_flagged_transactions(2, 3)'
    );
    expect(screen.getByText('(0/3) signed').getAttribute('data-icon')).toBe('risk');
    expect(screen.queryByTestId('multisign-risks-popover')).toBeNull();
  });

  it('signs the batch only through the risk review’s confirmation', () => {
    const logic = multiSignLogic({ batchRiskReview: summary });
    renderMultiSign(logic);

    fireEvent.click(screen.getByTestId('batch-risk-close'));
    expect(logic.onBatchRiskClose).toHaveBeenCalledTimes(1);
    expect(logic.onBatchRiskConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('batch-risk-confirm'));
    expect(logic.onBatchRiskConfirm).toHaveBeenCalledTimes(1);
  });

  it('closes the risk review instead of signing for an unverified website not yet acknowledged', () => {
    const logic = multiSignLogic({ batchRiskReview: summary, websiteCheckStatus: 'unverified' });
    renderMultiSign(logic);

    fireEvent.click(screen.getByTestId('batch-risk-confirm'));

    expect(logic.onBatchRiskConfirm).not.toHaveBeenCalled();
    expect(logic.onBatchRiskClose).toHaveBeenCalledTimes(1);
  });

  it('shows no flag for a clean batch', () => {
    renderMultiSign(
      multiSignLogic({
        batchRiskIndexes: [],
        localPsbtSummary: { ...summary, items: [items[0], items[0], items[0]] },
        multiSignList: [0, 1, 2].map((index) => ({
          index,
          buttonText: 'view',
          buttonPreset: 'primary',
          psbtInfo: items[0],
          onClick: vi.fn()
        }))
      })
    );

    expect(screen.queryByTestId('multisign-flagged-transactions')).toBeNull();
    expect(screen.queryByTestId('multisign-transaction-risk-1')).toBeNull();
    expect(screen.getByText('(0/3) signed').getAttribute('data-icon')).toBeNull();
  });
});
