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

vi.mock('@/ui/components/ColdWallet/ColdWalletSignPsbt', () => ({ default: () => null }));
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
vi.mock('@/ui/theme/colors', () => ({
  colors: { border: '', surface: '', warning_bg: '#fff4cc', warning_content: '#f4b62c' }
}));
vi.mock('@/ui/theme/font', () => ({ fontSizes: { xs: 12, sm: 14, xxxl: 32 } }));
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
