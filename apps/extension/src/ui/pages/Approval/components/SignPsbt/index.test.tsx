import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  const Text = ({ text, 'data-testid': dataTestId }: { text?: string; 'data-testid'?: string }) =>
    React.createElement('span', { 'data-testid': dataTestId }, text);

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
    Text,
    Tooltip: Container
  };
});

const coldWalletSigner = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/ui/components/ColdWallet/ColdWalletSignPsbt', () => ({
  default: (props: Record<string, unknown>) => {
    coldWalletSigner.props.push(props);
    return null;
  }
}));
vi.mock('@/ui/components/ContractPopover', () => ({ ContractPopover: () => null }));
vi.mock('@/ui/components/PhishingDetection', () => ({ PhishingDetection: () => null }));
vi.mock('@/ui/components/SignPsbtWithRisksPopover', async () => {
  const React = await import('react');
  return {
    SignPsbtWithRisksPopover: ({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) =>
      React.createElement(
        'div',
        null,
        React.createElement('button', { onClick: onConfirm, 'data-testid': 'psbt-risk-popover-confirm' }),
        React.createElement('button', { onClick: onClose, 'data-testid': 'psbt-risk-popover-close' })
      )
  };
});
vi.mock('@/ui/components/WebsiteBar', () => ({ default: () => null }));
// The panels themselves have their own tests; here they only show what they were given.
vi.mock('@/ui/components/SigningProgress', async (importOriginal) => {
  const React = await import('react');
  return {
    ...(await importOriginal<typeof import('@/ui/components/SigningProgress')>()),
    SigningProgress: ({ progress }: { progress: unknown }) =>
      React.createElement('div', { 'data-testid': 'signing-progress', 'data-progress': JSON.stringify(progress) }),
    LongSigningNotice: ({ inputCount }: { inputCount: number }) =>
      React.createElement('div', { 'data-testid': 'long-signing-notice' }, `${inputCount}`)
  };
});
vi.mock('@/ui/theme/colors', () => ({
  colors: { border: '', surface: '', warning_bg: '#fff4cc', warning_content: '#f4b62c' }
}));
vi.mock('@/ui/theme/font', () => ({ fontSizes: { xs: 12, sm: 14, xxxl: 32 } }));
vi.mock('@qbit/base-utils', () => ({ numUtils: { satoshisToAmount: () => '0' } }));
vi.mock('rc-virtual-list', async () => {
  const React = await import('react');
  return { default: React.forwardRef(() => null) };
});

vi.mock('@qbit/wallet-shared', async (importOriginal) => ({
  AccountSignMethod: {
    Local: 'local',
    ColdWallet: 'coldWallet',
    External: 'external',
    None: 'none'
  },
  isWebsiteSuppliedPsbt: (await importOriginal<typeof import('@qbit/wallet-shared')>()).isWebsiteSuppliedPsbt
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
vi.mock('./components/AssetOverviewSection', () => ({ default: () => null }));
vi.mock('./components/InputsList', () => ({ InputsList: () => null }));
vi.mock('./components/MultiSignDisclaimerModal', () => ({ default: () => null }));
vi.mock('./components/OutputsList', () => ({ OutputsList: () => null }));
vi.mock('./components/PsbtDataSection', () => ({ default: () => null }));
vi.mock('./components/Section', () => ({
  SignPsbtSection: ({ children }: { children?: ReactNode }) => children
}));
vi.mock('../ProviderContextCard', () => ({ default: () => null }));

const session = {
  origin: 'https://approval.example',
  icon: '',
  name: 'Approval'
};

const onClickSign = vi.fn();
const onClickBack = vi.fn();
const onRiskPopoverConfirm = vi.fn();
const onRiskPopoverClose = vi.fn();
const confirmQbitRestoredFloorSigning = vi.fn();

const toSignData = (challengeId?: string) =>
  ({
    psbtHex: '70736274ff',
    toSignInputs: [],
    action: 'send',
    signatureBudget: {
      required: 1,
      cached: 0,
      remainingBefore: 100,
      remainingAfter: 99,
      limit: 1073741824,
      ...(challengeId
        ? {
            restoredFloorRisk: {
              recoveryStatus: 'seed-only-restored',
              counterConfidence: 'chain-floor-only',
              knownOnChainSignatures: 7,
              challengeId
            }
          }
        : {})
    }
  } as any);

function signPsbtLogic(currentToSignData: any, overrides: Record<string, unknown> = {}) {
  return {
    showLoading: false,
    isPsbtRiskPopoverVisible: false,
    contractPopoverData: undefined,
    setContractPopoverData: vi.fn(),
    t: (key: string) => key,
    session,
    toSignDatas: [currentToSignData],
    currentToSignData,
    currentDecodedPsbt: { risks: [], inputInfos: [], outputInfos: [] },
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
    decodeError: false,
    websiteCheckStatus: 'clear',
    websiteCheckWarning: '',
    isAllSigned: false,
    signedCount: 0,
    multiSignList: [],
    isValid: true,
    networkFee: '0',
    hasRisk: false,
    showFeeSection: false,
    isBlocked: false,
    allowQuickMultiSign: false,
    onClickBack,
    onClickSign,
    onRetryDecode: vi.fn(),
    onRetryWebsiteCheck: vi.fn(),
    onRejectApprovalError: vi.fn(),
    onQuickMultiSign: vi.fn(),
    onTryMultiSign: vi.fn(),
    onTrustSite: vi.fn(),
    onColdWalletSigningSuccess: vi.fn(),
    onColdWalletSigningBack: vi.fn(),
    onRiskPopoverConfirm,
    onRiskPopoverClose,
    onDisclaimerModalClose: vi.fn(),
    ...overrides
  } as unknown as ReturnType<typeof useSignPsbtLogic>;
}

function renderSignPsbt(logic: ReturnType<typeof useSignPsbtLogic>) {
  vi.mocked(useSignPsbtLogic).mockReturnValue(logic);
  return render(<SignPsbt params={{ data: { toSignDatas: (logic as any).toSignDatas }, session }} />);
}

describe('SignPsbt restored-floor single-flight signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmQbitRestoredFloorSigning.mockReset();
    vi.mocked(useCurrentAccountCapabilities).mockReturnValue({ signMethod: 'local' } as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBIT' as any);
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({ confirmQbitRestoredFloorSigning } as any);
  });

  afterEach(cleanup);

  it('signs ordinary requests immediately without a restored-floor confirmation', () => {
    renderSignPsbt(signPsbtLogic(toSignData()));

    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(false);
    fireEvent.click(signButton);

    expect(onClickSign).toHaveBeenCalledTimes(1);
    expect(confirmQbitRestoredFloorSigning).not.toHaveBeenCalled();
  });

  it('confirms and signs once when the sign button is double-clicked in one update', async () => {
    let resolveConfirm!: () => void;
    confirmQbitRestoredFloorSigning.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      })
    );
    renderSignPsbt(signPsbtLogic(toSignData('challenge-7')));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    // Both clicks dispatch before React re-renders with the disabled
    // button, so only the synchronous lock can stop the duplicate.
    act(() => {
      fireEvent.click(signButton);
      fireEvent.click(signButton);
    });

    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(1);
    expect(signButton.disabled).toBe(true);

    await act(async () => {
      resolveConfirm();
    });

    expect(onClickSign).toHaveBeenCalledTimes(1);
    expect(signButton.disabled).toBe(true);

    // A late click after the handoff must not start another confirmation.
    fireEvent.click(signButton);
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(1);
    expect(onClickSign).toHaveBeenCalledTimes(1);
  });

  it('re-arms the sign button after a failed confirmation so it can be retried', async () => {
    const toastError = vi.fn();
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError } as any);
    confirmQbitRestoredFloorSigning.mockRejectedValueOnce(new Error('confirmation expired'));
    renderSignPsbt(signPsbtLogic(toSignData('challenge-7')));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    fireEvent.click(signButton);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('confirmation expired'));
    expect(onClickSign).not.toHaveBeenCalled();
    expect(signButton.disabled).toBe(false);

    confirmQbitRestoredFloorSigning.mockResolvedValueOnce(undefined);
    fireEvent.click(signButton);

    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(1));
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(2);
  });

  it('toasts the message carried by a plain port error object', async () => {
    const toastError = vi.fn();
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError } as any);
    // Background rejections cross the port as plain { message, code? }
    // objects, not Error instances.
    confirmQbitRestoredFloorSigning.mockRejectedValueOnce({
      message: 'qbit_recovery_signing_confirmation_expired',
      code: 1
    });
    renderSignPsbt(signPsbtLogic(toSignData('challenge-7')));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    fireEvent.click(screen.getByTestId('sign-psbt-button'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('qbit_recovery_signing_confirmation_expired'));
    expect(toastError).not.toHaveBeenCalledWith('[object Object]');
  });

  it('re-arms the sign button when local signing fails and the approval stays open', async () => {
    confirmQbitRestoredFloorSigning.mockResolvedValue(undefined);
    onClickSign.mockResolvedValueOnce(false);
    renderSignPsbt(signPsbtLogic(toSignData('challenge-7')));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    fireEvent.click(signButton);

    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(1));
    // The failed attempt left the challenge unconsumed, so the button must
    // come back instead of staying dead for the rest of the approval.
    await waitFor(() => expect(signButton.disabled).toBe(false));

    fireEvent.click(signButton);
    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(2));
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(2);
    expect(signButton.disabled).toBe(true);
  });

  it('re-arms the sign button when local signing fails after the risk popover handoff', async () => {
    confirmQbitRestoredFloorSigning.mockResolvedValue(undefined);
    const { rerender } = renderSignPsbt(signPsbtLogic(toSignData('challenge-7'), { hasRisk: true }));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    fireEvent.click(screen.getByTestId('sign-psbt-button'));
    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(1));

    vi.mocked(useSignPsbtLogic).mockReturnValue(
      signPsbtLogic(toSignData('challenge-7'), { hasRisk: true, isPsbtRiskPopoverVisible: true })
    );
    rerender(<SignPsbt params={{ data: { toSignDatas: [toSignData('challenge-7')] }, session }} />);

    onRiskPopoverConfirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId('psbt-risk-popover-confirm'));
    await waitFor(() => expect(onRiskPopoverConfirm).toHaveBeenCalledTimes(1));

    vi.mocked(useSignPsbtLogic).mockReturnValue(signPsbtLogic(toSignData('challenge-7'), { hasRisk: true }));
    rerender(<SignPsbt params={{ data: { toSignDatas: [toSignData('challenge-7')] }, session }} />);

    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    await waitFor(() => expect(signButton.disabled).toBe(false));

    fireEvent.click(signButton);
    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(2));
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(2);
  });

  it('does not launch signing when the approval is rejected while confirmation is pending', async () => {
    let resolveConfirm!: () => void;
    confirmQbitRestoredFloorSigning.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      })
    );
    renderSignPsbt(signPsbtLogic(toSignData('challenge-7')));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    fireEvent.click(screen.getByTestId('sign-psbt-button'));
    fireEvent.click(screen.getByText('reject'));
    expect(onClickBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConfirm();
    });

    expect(onClickSign).not.toHaveBeenCalled();
  });

  it('does not launch signing when the screen unmounts while confirmation is pending', async () => {
    let resolveConfirm!: () => void;
    confirmQbitRestoredFloorSigning.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      })
    );
    const { unmount } = renderSignPsbt(signPsbtLogic(toSignData('challenge-7')));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    fireEvent.click(screen.getByTestId('sign-psbt-button'));
    unmount();

    await act(async () => {
      resolveConfirm();
    });

    expect(onClickSign).not.toHaveBeenCalled();
  });

  it('resets the guard when the request moves to a different challenge', async () => {
    let resolveFirstConfirm!: () => void;
    confirmQbitRestoredFloorSigning.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFirstConfirm = resolve;
      })
    );
    const { rerender } = renderSignPsbt(signPsbtLogic(toSignData('challenge-7')));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    fireEvent.click(screen.getByTestId('sign-psbt-button'));
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(1);

    // The next item arrives with its own one-shot challenge while the
    // first confirmation is still pending.
    const nextToSignData = toSignData('challenge-8');
    vi.mocked(useSignPsbtLogic).mockReturnValue(signPsbtLogic(nextToSignData));
    rerender(<SignPsbt params={{ data: { toSignDatas: [nextToSignData] }, session }} />);

    await act(async () => {
      resolveFirstConfirm();
    });
    expect(onClickSign).not.toHaveBeenCalled();

    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    confirmQbitRestoredFloorSigning.mockResolvedValueOnce(undefined);
    fireEvent.click(signButton);

    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(1));
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(2);
    expect(confirmQbitRestoredFloorSigning).toHaveBeenLastCalledWith('challenge-8');
  });

  it('hands off to the risk popover once and keeps the sign button locked behind it', async () => {
    confirmQbitRestoredFloorSigning.mockResolvedValue(undefined);
    const { rerender } = renderSignPsbt(signPsbtLogic(toSignData('challenge-7'), { hasRisk: true }));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    fireEvent.click(signButton);
    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(1));

    // The hook now shows the risk popover; the sign button behind it stays
    // locked so the confirmation cannot be re-entered.
    vi.mocked(useSignPsbtLogic).mockReturnValue(
      signPsbtLogic(toSignData('challenge-7'), { hasRisk: true, isPsbtRiskPopoverVisible: true })
    );
    rerender(<SignPsbt params={{ data: { toSignDatas: [toSignData('challenge-7')] }, session }} />);
    expect((screen.getByTestId('sign-psbt-button') as HTMLButtonElement).disabled).toBe(true);

    const popoverConfirm = screen.getByTestId('psbt-risk-popover-confirm');
    act(() => {
      fireEvent.click(popoverConfirm);
      fireEvent.click(popoverConfirm);
    });

    expect(onRiskPopoverConfirm).toHaveBeenCalledTimes(1);
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(1);
  });

  it('re-arms the sign button when the risk popover is dismissed without signing', async () => {
    confirmQbitRestoredFloorSigning.mockResolvedValue(undefined);
    const { rerender } = renderSignPsbt(signPsbtLogic(toSignData('challenge-7'), { hasRisk: true }));

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    fireEvent.click(screen.getByTestId('sign-psbt-button'));
    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(1));

    vi.mocked(useSignPsbtLogic).mockReturnValue(
      signPsbtLogic(toSignData('challenge-7'), { hasRisk: true, isPsbtRiskPopoverVisible: true })
    );
    rerender(<SignPsbt params={{ data: { toSignDatas: [toSignData('challenge-7')] }, session }} />);

    fireEvent.click(screen.getByTestId('psbt-risk-popover-close'));
    expect(onRiskPopoverClose).toHaveBeenCalledTimes(1);

    vi.mocked(useSignPsbtLogic).mockReturnValue(signPsbtLogic(toSignData('challenge-7'), { hasRisk: true }));
    rerender(<SignPsbt params={{ data: { toSignDatas: [toSignData('challenge-7')] }, session }} />);

    const signButton = screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(false);
    fireEvent.click(signButton);

    await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(2));
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(2);
  });
});

describe('SignPsbt cold-wallet signing', () => {
  const providerContext = {
    origin: session.origin,
    account: 'qbrt1zaccount',
    chain: 'QBIT_REGTEST',
    network: 'regtest'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    coldWalletSigner.props = [];
    vi.mocked(useCurrentAccountCapabilities).mockReturnValue({ signMethod: 'coldWallet' } as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBIT' as any);
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({} as any);
  });

  afterEach(cleanup);

  it("tells the signer's request whether a website supplied the PSBT", () => {
    const supplied = { ...toSignData(), providerContext };
    renderSignPsbt(signPsbtLogic(supplied, { isColdWalletSigning: true }));
    cleanup();
    // A website's sendQbit carries the claim minted at its approval: the wallet built it.
    renderSignPsbt(
      signPsbtLogic({ ...supplied, qbitSendBroadcastClaim: { origin: session.origin } }, { isColdWalletSigning: true })
    );
    cleanup();
    renderSignPsbt(signPsbtLogic(toSignData(), { isColdWalletSigning: true }));

    expect(coldWalletSigner.props.map(({ psbtHex, suppliedByWebsite }) => [psbtHex, suppliedByWebsite])).toEqual([
      ['70736274ff', true],
      ['70736274ff', false],
      ['70736274ff', false]
    ]);
  });
});

describe('SignPsbt while it signs (#171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCurrentAccountCapabilities).mockReturnValue({ signMethod: 'local' } as any);
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBIT' as any);
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({ confirmQbitRestoredFloorSigning } as any);
  });

  afterEach(cleanup);

  const signButton = () => screen.getByTestId('sign-psbt-button') as HTMLButtonElement;
  const button = (text: string) => screen.getByText(text) as HTMLButtonElement;

  it('shows the progress in place of the review while many inputs sign, with nothing to press', () => {
    renderSignPsbt(
      signPsbtLogic(toSignData(), {
        isPsbtSigning: true,
        signingInputCount: 106,
        signingProgress: { signed: 36, total: 106 }
      })
    );

    expect(JSON.parse(screen.getByTestId('signing-progress').dataset.progress!)).toEqual({ signed: 36, total: 106 });
    expect(screen.queryByTestId('long-signing-notice')).toBeNull();
    expect(button('reject').disabled).toBe(true);
    expect(signButton().disabled).toBe(true);
    expect(signButton().textContent).toBe('signing_in_progress');
    fireEvent.click(signButton());
    expect(onClickSign).not.toHaveBeenCalled();
  });

  it('keeps a short signing on the review, with Sign and Reject locked', () => {
    renderSignPsbt(
      signPsbtLogic(toSignData(), {
        isPsbtSigning: true,
        signingInputCount: 2,
        signingProgress: { signed: 1, total: 2 }
      })
    );

    expect(screen.queryByTestId('signing-progress')).toBeNull();
    expect(button('reject').disabled).toBe(true);
    expect(signButton().disabled).toBe(true);
    expect(signButton().textContent).toBe('signing_in_progress');
  });

  it('keeps Reject locked when the screen falls back to loading or an error mid-signing', () => {
    const view = renderSignPsbt(signPsbtLogic(toSignData(), { isPsbtSigning: true, showLoading: true }));
    expect((screen.getByTestId('psbt-loading-reject-button') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();

    renderSignPsbt(signPsbtLogic(toSignData(), { isPsbtSigning: true, decodeError: true }));
    expect((screen.getByTestId('psbt-error-reject-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('psbt-error-retry-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says before Sign that signing many inputs takes a while', () => {
    renderSignPsbt(signPsbtLogic(toSignData(), { signingInputCount: 106 }));

    expect(screen.getByTestId('long-signing-notice').textContent).toBe('106');
    expect(signButton().disabled).toBe(false);
    expect(signButton().textContent).toBe('sign');
  });

  it('keeps Sign disabled for a transaction already signed, with Reject available', () => {
    renderSignPsbt(signPsbtLogic(toSignData(), { currentSigned: true, signingInputCount: 2 }));

    expect(signButton().disabled).toBe(true);
    expect(button('reject').disabled).toBe(false);
  });

  it('ignores the website check Retry while a short signing runs', () => {
    const onRetryWebsiteCheck = vi.fn();
    renderSignPsbt(
      signPsbtLogic(toSignData(), {
        isPsbtSigning: true,
        signingInputCount: 2,
        websiteCheckStatus: 'unverified',
        websiteCheckWarning: 'Could not verify this website',
        onRetryWebsiteCheck
      })
    );

    fireEvent.click(screen.getByTestId('psbt-website-check-retry-button'));

    expect(onRetryWebsiteCheck).not.toHaveBeenCalled();
  });

  it('keeps the website check Retry disabled through the restored-floor confirmation', async () => {
    let resolveConfirm!: () => void;
    confirmQbitRestoredFloorSigning.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      })
    );
    const onRetryWebsiteCheck = vi.fn();
    renderSignPsbt(
      signPsbtLogic(toSignData('challenge-9'), {
        websiteCheckStatus: 'unverified',
        websiteCheckWarning: 'Could not verify this website',
        onRetryWebsiteCheck
      })
    );
    fireEvent.click(screen.getByTestId('psbt-unverified-website-confirmation'));
    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    const retry = screen.getByTestId('psbt-website-check-retry-button') as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    act(() => {
      fireEvent.click(signButton());
    });
    expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(1);
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(onRetryWebsiteCheck).not.toHaveBeenCalled();

    await act(async () => {
      resolveConfirm();
    });
  });

  it('says nothing about time for fewer inputs', () => {
    renderSignPsbt(signPsbtLogic(toSignData(), { signingInputCount: 19 }));

    expect(screen.queryByTestId('long-signing-notice')).toBeNull();
  });

  it("shows a quick-signed batch's progress in place of its list, with its buttons locked", () => {
    renderSignPsbt(
      signPsbtLogic(toSignData(), {
        showMultiSignView: true,
        toSignDatas: [toSignData(), toSignData()],
        isPsbtSigning: true,
        signingProgress: { signed: 3, total: 10, transactionIndex: 0, transactionCount: 2 }
      })
    );

    expect(JSON.parse(screen.getByTestId('signing-progress').dataset.progress!)).toMatchObject({
      transactionIndex: 0,
      transactionCount: 2
    });
    expect(button('reject_all').disabled).toBe(true);
    expect(button('signing_in_progress').disabled).toBe(true);
  });
});
