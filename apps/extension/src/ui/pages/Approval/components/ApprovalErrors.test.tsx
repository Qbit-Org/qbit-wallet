import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AccountSignMethod } from '@qbit/wallet-shared';
import {
  useApproval,
  useConnectWebsiteCheck,
  useCurrentAccount,
  useCurrentAccountCapabilities,
  useCurrentKeyring,
  useI18n,
  useQbitUnit,
  useSignMessageLogic,
  useSignPsbtLogic,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import Connect from './Connect';
import SignMessage from './SignMessage';
import SignPsbt from './SignPsbt';

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
  const Checkbox = ({
    checked,
    onChange,
    children,
    'data-testid': dataTestId
  }: {
    checked?: boolean;
    onChange?: (event: { target: { checked: boolean } }) => void;
    children?: ReactNode;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'label',
      { 'data-testid': dataTestId },
      React.createElement('input', {
        type: 'checkbox',
        checked,
        onChange,
        'data-testid': dataTestId ? `${dataTestId}-input` : undefined
      }),
      children
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

  return {
    Button,
    Card: Container,
    Checkbox,
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

vi.mock('@/ui/components/WebsiteBar', () => ({ default: () => null }));
vi.mock('@/ui/components/ColdWallet/ColdWalletSignPsbt', async () => {
  const React = await import('react');
  return {
    default: () => React.createElement('div', { 'data-testid': 'cold-wallet-signing' })
  };
});
vi.mock('@/ui/components/ColdWallet', async () => {
  const React = await import('react');
  return {
    ColdWalletSignMessage: () => React.createElement('div', { 'data-testid': 'cold-wallet-message-signing' })
  };
});
vi.mock('@/ui/components/ContractPopover', () => ({ ContractPopover: () => null }));
vi.mock('@/ui/components/LoadingPage', async () => {
  const React = await import('react');
  return {
    default: () => React.createElement('div', { 'data-testid': 'loading-page' })
  };
});
vi.mock('@/ui/components/PhishingDetection', async () => {
  const React = await import('react');
  return {
    PhishingDetection: () => React.createElement('div', { 'data-testid': 'phishing-detection' })
  };
});
vi.mock('@/ui/components/SignPsbtWithRisksPopover', async () => {
  const React = await import('react');
  return {
    SignPsbtWithRisksPopover: ({ onConfirm }: { onConfirm: () => void }) =>
      React.createElement('button', { onClick: onConfirm, 'data-testid': 'risk-confirm-button' })
  };
});
vi.mock('@/ui/theme/colors', () => ({
  colors: { border: '', surface: '', warning_bg: '#fff4cc', warning_content: '#f4b62c' }
}));
vi.mock('@/ui/theme/font', () => ({ fontSizes: { sm: 14, xxxl: 32 } }));
vi.mock('@/ui/utils', () => ({ shortAddress: (address: string) => address }));
vi.mock('@qbit/base-utils', () => ({ numUtils: { satoshisToAmount: () => '0' } }));
vi.mock('rc-virtual-list', async () => {
  const React = await import('react');
  return { default: React.forwardRef(() => null) };
});

vi.mock('@qbit/wallet-shared', () => ({
  AccountSignMethod: {
    Local: 'local',
    ColdWallet: 'coldWallet',
    External: 'external',
    None: 'none'
  }
}));

vi.mock('@qbit/wallet-state', () => ({
  useApproval: vi.fn(),
  useConnectWebsiteCheck: vi.fn(),
  useCurrentAccount: vi.fn(),
  useCurrentAccountCapabilities: vi.fn(),
  useCurrentKeyring: vi.fn(),
  useI18n: vi.fn(),
  useQbitUnit: vi.fn(),
  useSignMessageLogic: vi.fn(),
  useSignPsbtLogic: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

vi.mock('@/ui/pages/Approval/components/SignPsbt/components/ActionOverviewSection', () => ({ default: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/TransactionOverviewSection', () => ({ default: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/InputsList', () => ({ InputsList: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/MultiSignDisclaimerModal', () => ({ default: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/OutputsList', () => ({ OutputsList: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/PsbtDataSection', () => ({ default: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/Section', () => ({ SignPsbtSection: () => null }));

const session = {
  origin: 'https://example.test',
  icon: '',
  name: 'Example'
};

const toSignData: any = {
  psbtHex: 'private-psbt',
  toSignInputs: [],
  action: 'send'
};

const toSignMessage = {
  text: 'Message to sign',
  type: 'p2mr'
};

function createSignMessageLogicResult(
  overrides: Record<string, unknown> = {}
): ReturnType<typeof useSignMessageLogic> {
  return {
    loading: false,
    t: (key: string) => key,
    session,
    isColdWalletSigning: false,
    showMultiSignView: false,
    disclaimerVisible: false,
    toSignMessages: [toSignMessage],
    currentToSignMessage: toSignMessage,
    websiteCheckStatus: 'clear',
    websiteCheckWarning: '',
    isBlocked: false,
    allowQuickMultiSign: false,
    isAllSigned: false,
    signedCount: 0,
    multiSignList: [],
    onClickBack: vi.fn(),
    onClickSign: vi.fn(),
    onRetryWebsiteCheck: vi.fn(),
    onQuickMultiSign: vi.fn(),
    onTryMultiSign: vi.fn(),
    onTrustSite: vi.fn(),
    onColdWalletSigningSuccess: vi.fn(),
    onColdWalletSigningBack: vi.fn(),
    readonlySignature: '',
    setReadonlySignature: vi.fn(),
    onDisclaimerModalClose: vi.fn(),
    ...overrides
  } as unknown as ReturnType<typeof useSignMessageLogic>;
}

function createSignPsbtLogicResult(overrides: Record<string, unknown> = {}): ReturnType<typeof useSignPsbtLogic> {
  return {
    showLoading: false,
    decodeError: false,
    websiteCheckStatus: 'clear',
    websiteCheckWarning: '',
    isPsbtRiskPopoverVisible: false,
    contractPopoverData: undefined,
    setContractPopoverData: vi.fn(),
    t: (key: string) => key,
    session,
    toSignDatas: [toSignData],
    currentToSignData: toSignData,
    currentDecodedPsbt: {},
    readonlySignedPsbtHex: '',
    setReadonlySignedPsbtHex: vi.fn(),
    isColdWalletSigning: false,
    showMultiSignView: false,
    disclaimerVisible: false,
    localPsbtSummary: null,
    batchRiskReview: null,
    batchRiskIndexes: [],
    onBatchRiskConfirm: vi.fn(),
    onBatchRiskClose: vi.fn(),
    isAllSigned: false,
    signedCount: 0,
    multiSignList: [],
    isValid: true,
    networkFee: '0',
    hasRisk: false,
    showFeeSection: false,
    isBlocked: false,
    allowQuickMultiSign: false,
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
    ...overrides
  } as unknown as ReturnType<typeof useSignPsbtLogic>;
}

describe('approval error recovery screens', () => {
  const approval = {
    resolveApproval: vi.fn(),
    rejectApproval: vi.fn()
  };

  beforeEach(() => {
    vi.mocked(useApproval).mockReturnValue(approval as any);
    vi.mocked(useConnectWebsiteCheck).mockReturnValue({
      status: 'checking',
      warning: '',
      retry: vi.fn(),
      result: undefined,
      guardVersionRef: { current: 0 },
      blockedRef: { current: false }
    } as unknown as ReturnType<typeof useConnectWebsiteCheck>);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useCurrentAccount).mockReturnValue({ address: 'bc1qexample', alianName: 'Account 1' } as any);
    vi.mocked(useCurrentKeyring).mockReturnValue({ alianName: 'Wallet 1' } as any);
    vi.mocked(useCurrentAccountCapabilities).mockReturnValue({ signMethod: AccountSignMethod.Local } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBIT');
    vi.mocked(useSignMessageLogic).mockReturnValue(createSignMessageLogicResult());
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({ confirmQbitRestoredFloorSigning: vi.fn() } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the regular connection UI with a prominent warning when the website check rejects', () => {
    const retry = vi.fn();
    vi.mocked(useConnectWebsiteCheck).mockReturnValue({
      status: 'unverified',
      warning: '',
      retry,
      result: undefined,
      guardVersionRef: { current: 0 },
      blockedRef: { current: false }
    } as unknown as ReturnType<typeof useConnectWebsiteCheck>);

    render(<Connect params={{ session }} />);

    expect(screen.getByTestId('website-check-warning').style.backgroundColor).toBe('rgb(255, 244, 204)');
    expect(screen.getByTestId('website-check-warning').style.border).toContain('rgb(244, 182, 44)');
    expect(screen.getByTestId('website-check-error').textContent).toBe('website_check_failed');
    expect(screen.getByText('Connect with Qbit Wallet')).not.toBeNull();
    expect(screen.getByText('Account 1')).not.toBeNull();
    expect(screen.getByText('unverified_website_confirmation').getAttribute('data-preset')).toBe('sub-bold');
    expect(screen.getByTestId('website-check-connect-button').textContent).toBe('connect');
    expect(screen.getByTestId('website-check-cancel-button')).not.toBeNull();
    expect(screen.getByTestId('website-check-retry-button').textContent).toBe('try_again');

    fireEvent.click(screen.getByTestId('website-check-retry-button'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('enables connection to an unverified website only after confirmation', () => {
    vi.mocked(useConnectWebsiteCheck).mockReturnValue({
      status: 'unverified',
      warning: '',
      retry: vi.fn(),
      result: undefined,
      guardVersionRef: { current: 0 },
      blockedRef: { current: false }
    } as unknown as ReturnType<typeof useConnectWebsiteCheck>);
    const { rerender } = render(<Connect approvalId="connect-approval-id" params={{ session }} />);

    const connectButton = screen.getByTestId('website-check-connect-button') as HTMLButtonElement;
    expect(connectButton.disabled).toBe(true);
    fireEvent.click(connectButton);
    expect(approval.resolveApproval).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('unverified-website-confirmation-input'));

    expect(connectButton.disabled).toBe(false);
    fireEvent.click(connectButton);
    expect(approval.resolveApproval).toHaveBeenCalledTimes(1);
    expect(approval.resolveApproval).toHaveBeenCalledWith('connect-approval-id');

    rerender(
      <Connect approvalId="connect-approval-id" params={{ session: { ...session, origin: 'https://another.test' } }} />
    );
    expect((screen.getByTestId('website-check-connect-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('unverified-website-confirmation-input') as HTMLInputElement).checked).toBe(false);
  });

  it('does not connect when a late blocked verdict invalidates an acknowledged unverified render', () => {
    const guardVersionRef = { current: 0 };
    const blockedRef = { current: false };
    vi.mocked(useConnectWebsiteCheck).mockReturnValue({
      status: 'unverified',
      warning: '',
      retry: vi.fn(),
      result: undefined,
      guardVersionRef,
      blockedRef
    } as unknown as ReturnType<typeof useConnectWebsiteCheck>);

    render(<Connect params={{ session }} />);

    fireEvent.click(screen.getByTestId('unverified-website-confirmation-input'));
    const connectButton = screen.getByTestId('website-check-connect-button') as HTMLButtonElement;
    expect(connectButton.disabled).toBe(false);

    guardVersionRef.current += 1;
    blockedRef.current = true;
    fireEvent.click(connectButton);

    expect(approval.resolveApproval).not.toHaveBeenCalled();
  });

  it('rejects the pending connection approval when Cancel is selected during the initial check', () => {
    render(<Connect approvalId="connect-approval-id" params={{ session }} />);

    fireEvent.click(screen.getByTestId('website-check-loading-cancel-button'));

    expect(approval.rejectApproval).toHaveBeenCalledWith('connect-approval-id', 'user_rejected_the_request');
  });

  it('shows the trusted origin and active Qbit context before connecting', () => {
    vi.mocked(useConnectWebsiteCheck).mockReturnValue({
      status: 'clear',
      warning: '',
      retry: vi.fn(),
      result: undefined,
      guardVersionRef: { current: 0 },
      blockedRef: { current: false }
    } as unknown as ReturnType<typeof useConnectWebsiteCheck>);
    const context = {
      origin: session.origin,
      account: 'qbrt1zapprovalaccount',
      chain: 'QBIT_TESTNET4',
      network: 'testnet4'
    } as any;

    render(<Connect params={{ data: { context }, session }} />);

    const contextCard = within(screen.getByTestId('qbit-provider-context'));
    expect(contextCard.getByText(session.origin)).not.toBeNull();
    expect(contextCard.getByText(context.account)).not.toBeNull();
    expect(contextCard.getByText(context.chain)).not.toBeNull();
    expect(contextCard.getByText(context.network)).not.toBeNull();
  });

  it('blocks a connection with no continue control for a blocked verdict', () => {
    vi.mocked(useConnectWebsiteCheck).mockReturnValue({
      status: 'blocked',
      warning: 'Blocked website',
      retry: vi.fn(),
      result: undefined,
      guardVersionRef: { current: 1 },
      blockedRef: { current: true }
    } as unknown as ReturnType<typeof useConnectWebsiteCheck>);

    render(<Connect approvalId="connect-approval-id" params={{ session }} />);

    expect(screen.getByText('phishing_detection')).not.toBeNull();
    expect(screen.queryByText('connect')).toBeNull();
    fireEvent.click(screen.getByText('reject_blocked_request'));
    expect(approval.rejectApproval).toHaveBeenCalledWith('connect-approval-id', 'user_rejected_the_request');
  });

  it('requires warning acknowledgement before single-message signing and exposes retry', () => {
    const onClickSign = vi.fn();
    const onRetryWebsiteCheck = vi.fn();
    vi.mocked(useSignMessageLogic).mockReturnValue(
      createSignMessageLogicResult({
        websiteCheckStatus: 'unverified',
        websiteCheckWarning: 'Local website warning',
        onClickSign,
        onRetryWebsiteCheck
      })
    );

    render(
      <SignMessage
        params={{ data: { toSignMessages: [toSignMessage as any] }, session }}
      />
    );

    expect(screen.getByTestId('message-website-check-error').textContent).toBe(
      'Local website warning'
    );
    const signButton = screen.getByTestId('sign-message-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('message-website-check-retry-button'));
    expect(onRetryWebsiteCheck).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('message-unverified-website-confirmation-input'));
    expect(signButton.disabled).toBe(false);
    fireEvent.click(signButton);
    expect(onClickSign).toHaveBeenCalledTimes(1);
  });

  it('requires the same warning acknowledgement before batch-message signing', () => {
    const onTryMultiSign = vi.fn();
    const messages = [toSignMessage, { ...toSignMessage, text: 'Second message' }];
    vi.mocked(useSignMessageLogic).mockReturnValue(
      createSignMessageLogicResult({
        websiteCheckStatus: 'unverified',
        showMultiSignView: true,
        toSignMessages: messages,
        currentToSignMessage: undefined,
        onTryMultiSign
      })
    );

    render(
      <SignMessage params={{ data: { toSignMessages: messages as any }, session }} />
    );

    const batchButton = screen.getByText('(0/2) signed') as HTMLButtonElement;
    expect(batchButton.disabled).toBe(true);
    fireEvent.click(batchButton);
    expect(onTryMultiSign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('message-unverified-website-confirmation-input'));
    expect(batchButton.disabled).toBe(false);
    fireEvent.click(batchButton);
    expect(onTryMultiSign).toHaveBeenCalledTimes(1);
  });

  it('renders a blocked message verdict before loading or signing controls', () => {
    vi.mocked(useSignMessageLogic).mockReturnValue(
      createSignMessageLogicResult({
        loading: true,
        websiteCheckStatus: 'blocked',
        isBlocked: true
      })
    );

    render(
      <SignMessage
        params={{ data: { toSignMessages: [toSignMessage as any] }, session }}
      />
    );

    expect(screen.getByTestId('phishing-detection')).not.toBeNull();
    expect(screen.queryByTestId('sign-message-button')).toBeNull();
  });

  it('keeps message-check loading actionable with Reject', () => {
    const onClickBack = vi.fn();
    vi.mocked(useSignMessageLogic).mockReturnValue(
      createSignMessageLogicResult({
        loading: true,
        websiteCheckStatus: 'checking',
        onClickBack
      })
    );

    render(
      <SignMessage
        params={{ data: { toSignMessages: [toSignMessage as any] }, session }}
      />
    );

    fireEvent.click(screen.getByTestId('message-check-loading-reject-button'));
    expect(onClickBack).toHaveBeenCalledTimes(1);
  });

  it('keeps an active cold-wallet message flow mounted while the website check restarts', () => {
    let logicResult = createSignMessageLogicResult({ isColdWalletSigning: true });
    vi.mocked(useSignMessageLogic).mockImplementation(() => logicResult);

    const { rerender } = render(
      <SignMessage params={{ data: { toSignMessages: [toSignMessage as any] }, session }} />
    );
    const coldWalletSigning = screen.getByTestId('cold-wallet-message-signing');

    logicResult = createSignMessageLogicResult({
      loading: true,
      websiteCheckStatus: 'checking',
      isColdWalletSigning: true
    });
    rerender(<SignMessage params={{ data: { toSignMessages: [toSignMessage as any] }, session }} />);

    expect(screen.getByTestId('cold-wallet-message-signing')).toBe(coldWalletSigning);
    expect(screen.queryByTestId('message-check-loading-reject-button')).toBeNull();
  });

  it('hands the rendered approval id to the signing logic', () => {
    vi.mocked(useSignPsbtLogic).mockReturnValue(createSignPsbtLogicResult());
    render(<SignPsbt approvalId="psbt-approval-id" params={{ data: { toSignDatas: [toSignData] }, session }} />);
    expect(useSignPsbtLogic).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'psbt-approval-id' }));

    cleanup();
    render(
      <SignMessage
        approvalId="message-approval-id"
        params={{ data: { toSignMessages: [toSignMessage as any] }, session }}
      />
    );
    expect(useSignMessageLogic).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'message-approval-id' }));
  });

  it('shows transaction review with a prominent warning when the website check rejects', () => {
    const onRetryWebsiteCheck = vi.fn();
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        websiteCheckStatus: 'unverified',
        onRetryWebsiteCheck
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

    expect(screen.getByTestId('psbt-website-check-warning').style.backgroundColor).toBe('rgb(255, 244, 204)');
    expect(screen.getByTestId('psbt-website-check-warning').style.border).toContain('rgb(244, 182, 44)');
    expect(screen.getByTestId('psbt-website-check-error').textContent).toBe('website_check_failed');
    expect(screen.getByText('unverified_website_confirmation').getAttribute('data-preset')).toBe('sub-bold');
    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(true);
    expect(screen.queryByTestId('psbt-error-reject-button')).toBeNull();

    fireEvent.click(screen.getByTestId('psbt-unverified-website-confirmation-input'));
    expect(signButton.disabled).toBe(false);

    fireEvent.click(screen.getByTestId('psbt-website-check-retry-button'));
    expect(onRetryWebsiteCheck).toHaveBeenCalledTimes(1);
    expect(signButton.disabled).toBe(true);
    expect((screen.getByTestId('psbt-unverified-website-confirmation-input') as HTMLInputElement).checked).toBe(false);
  });

  it('enables transaction signing only after confirmation and resets confirmation for another origin', () => {
    const onClickSign = vi.fn();
    vi.mocked(useSignPsbtLogic).mockImplementation((props: Parameters<typeof useSignPsbtLogic>[0]) =>
      createSignPsbtLogicResult({
        websiteCheckStatus: 'unverified',
        session: props.params.session,
        onClickSign
      })
    );
    const { rerender } = render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(true);
    fireEvent.click(signButton);
    expect(onClickSign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('psbt-unverified-website-confirmation-input'));

    expect(signButton.disabled).toBe(false);
    fireEvent.click(signButton);
    expect(onClickSign).toHaveBeenCalledTimes(1);

    rerender(
      <SignPsbt
        params={{ data: { toSignDatas: [toSignData] }, session: { ...session, origin: 'https://another.test' } }}
      />
    );
    expect((screen.getByTestId('sign-psbt-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('psbt-unverified-website-confirmation-input') as HTMLInputElement).checked).toBe(false);
  });

  it('keeps an active cold-wallet signing flow mounted when the website check restarts', () => {
    const anotherSession = { ...session, origin: 'https://another.test' };
    let logicResult = createSignPsbtLogicResult({ websiteCheckStatus: 'unverified' });
    vi.mocked(useSignPsbtLogic).mockImplementation(() => logicResult);

    const { rerender } = render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

    fireEvent.click(screen.getByTestId('psbt-unverified-website-confirmation-input'));
    logicResult = createSignPsbtLogicResult({ websiteCheckStatus: 'unverified', isColdWalletSigning: true });
    rerender(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);
    const coldWalletSigning = screen.getByTestId('cold-wallet-signing');

    logicResult = createSignPsbtLogicResult({
      showLoading: true,
      websiteCheckStatus: 'checking',
      isColdWalletSigning: true,
      session: anotherSession
    });
    rerender(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session: anotherSession }} />);

    expect(screen.getByTestId('cold-wallet-signing')).toBe(coldWalletSigning);
    expect(screen.queryByTestId('psbt-loading-reject-button')).toBeNull();
    expect(screen.queryByTestId('psbt-unverified-website-confirmation')).toBeNull();
  });

  it('does not enter risk-confirmed signing after the website acknowledgement is invalidated', () => {
    const onRiskPopoverConfirm = vi.fn();
    const onRiskPopoverClose = vi.fn();
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        websiteCheckStatus: 'unverified',
        isPsbtRiskPopoverVisible: true,
        onRiskPopoverConfirm,
        onRiskPopoverClose
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

    fireEvent.click(screen.getByTestId('risk-confirm-button'));
    expect(onRiskPopoverClose).toHaveBeenCalledTimes(1);
    expect(onRiskPopoverConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('psbt-unverified-website-confirmation-input'));
    fireEvent.click(screen.getByTestId('risk-confirm-button'));
    expect(onRiskPopoverConfirm).toHaveBeenCalledTimes(1);
  });

  it('requires the same confirmation before multi-transaction signing', () => {
    const onTryMultiSign = vi.fn();
    const toSignDatas = [toSignData, { ...toSignData, psbtHex: 'second-private-psbt' }];
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        websiteCheckStatus: 'unverified',
        showMultiSignView: true,
        toSignDatas,
        currentToSignData: undefined,
        currentDecodedPsbt: undefined,
        isValid: false,
        onTryMultiSign
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas }, session }} />);

    const multiSignButton = screen.getByText('(0/2) signed') as HTMLButtonElement;
    expect(multiSignButton.disabled).toBe(true);
    fireEvent.click(multiSignButton);
    expect(onTryMultiSign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('psbt-unverified-website-confirmation-input'));

    expect(multiSignButton.disabled).toBe(false);
    fireEvent.click(multiSignButton);
    expect(onTryMultiSign).toHaveBeenCalledTimes(1);
  });

  it('quick-signs trusted multi-transaction requests without opening the disclaimer', () => {
    const onQuickMultiSign = vi.fn();
    const onTryMultiSign = vi.fn();
    const toSignDatas = [toSignData, { ...toSignData, psbtHex: 'second-private-psbt' }];
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        showMultiSignView: true,
        toSignDatas,
        currentToSignData: undefined,
        currentDecodedPsbt: undefined,
        isValid: false,
        allowQuickMultiSign: true,
        onQuickMultiSign,
        onTryMultiSign
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas }, session }} />);

    fireEvent.click(screen.getByText('(0/2) signed'));

    expect(onQuickMultiSign).toHaveBeenCalledTimes(1);
    expect(onTryMultiSign).not.toHaveBeenCalled();
  });

  it('requires individual review for every Qbit provider batch transaction', () => {
    const onTryMultiSign = vi.fn();
    const context = {
      origin: session.origin,
      account: 'qbrt1zapprovalaccount',
      chain: 'QBIT_TESTNET4',
      network: 'testnet4'
    } as any;
    const toSignDatas = [
      { ...toSignData, providerContext: context },
      { ...toSignData, psbtHex: 'second-private-psbt', providerContext: context }
    ];
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        showMultiSignView: true,
        toSignDatas,
        currentToSignData: undefined,
        currentDecodedPsbt: undefined,
        isValid: false,
        onTryMultiSign
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas }, context, session }} />);

    expect(screen.getByTestId('qbit-provider-batch-review-required')).not.toBeNull();
    const contextCard = within(screen.getByTestId('qbit-provider-context'));
    expect(contextCard.getByText(context.origin)).not.toBeNull();
    expect(contextCard.getByText(context.network)).not.toBeNull();
    expect(screen.queryByText('(0/2) signed')).toBeNull();
    expect(onTryMultiSign).not.toHaveBeenCalled();
  });

  it('does not allow the verification-error override for a website identified as malicious', () => {
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        websiteCheckStatus: 'unverified',
        isBlocked: true
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

    expect(screen.getByTestId('phishing-detection')).not.toBeNull();
    expect(screen.queryByTestId('sign-psbt-button')).toBeNull();
    expect(screen.queryByTestId('psbt-unverified-website-confirmation')).toBeNull();
  });

  it('keeps PSBT loading actionable with Reject', () => {
    const onClickBack = vi.fn();
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        showLoading: true,
        websiteCheckStatus: 'checking',
        onClickBack
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

    fireEvent.click(screen.getByTestId('psbt-loading-reject-button'));
    expect(onClickBack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['loading page', { showLoading: true }],
    ['PSBT decode error', { decodeError: true }]
  ])('renders phishing detection before the %s', (_state, overrides) => {
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        ...overrides,
        isBlocked: true
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

    expect(screen.getByTestId('phishing-detection')).not.toBeNull();
    expect(screen.queryByTestId('loading-page')).toBeNull();
    expect(screen.queryByTestId('psbt-decode-error')).toBeNull();
  });

  it('renders a PSBT decode error before the loading page and exposes recovery actions', () => {
    const onRetryDecode = vi.fn();
    const onRejectApprovalError = vi.fn();
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      createSignPsbtLogicResult({
        showLoading: true,
        decodeError: true,
        currentToSignData: undefined,
        currentDecodedPsbt: undefined,
        isValid: false,
        onRetryDecode,
        onRejectApprovalError
      })
    );

    render(<SignPsbt params={{ data: { toSignDatas: [] }, session }} />);

    expect(screen.getByTestId('psbt-decode-error').textContent).toBe('failed_to_parse_psbt');
    expect(screen.queryByTestId('loading-page')).toBeNull();

    fireEvent.click(screen.getByTestId('psbt-error-reject-button'));
    fireEvent.click(screen.getByTestId('psbt-error-retry-button'));
    expect(onRejectApprovalError).toHaveBeenCalledTimes(1);
    expect(onRetryDecode).toHaveBeenCalledTimes(1);
  });
});
