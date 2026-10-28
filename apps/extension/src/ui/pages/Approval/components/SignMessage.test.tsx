import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCurrentAccountCapabilities, useI18n, useSignMessageLogic, useTools, useWallet } from '@qbit/wallet-state';

import SignMessage from './SignMessage';

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

vi.mock('@/ui/components/ColdWallet', () => ({ ColdWalletSignMessage: () => null }));
vi.mock('@/ui/components/LoadingPage', () => ({ default: () => null }));
vi.mock('@/ui/components/PhishingDetection', () => ({ PhishingDetection: () => null }));
vi.mock('@/ui/components/WebsiteBar', () => ({ default: () => null }));
vi.mock('@/ui/theme/font', () => ({ fontSizes: { sm: 14 } }));
vi.mock('./SignPsbt/components/MultiSignDisclaimerModal', () => ({ default: () => null }));
vi.mock('./SignPsbt/components/Section', () => ({
  SignPsbtSection: ({ children }: { children?: ReactNode }) => children
}));

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
  useSignMessageLogic: vi.fn(),
  useTools: vi.fn(),
  useWallet: vi.fn()
}));

const context = {
  origin: 'https://approval.example',
  account: 'qbrt1zmessageaccount',
  chain: 'QBIT_TESTNET4',
  network: 'testnet4'
} as any;
const text = 'Qbit approval\n雪';
const toSignMessage = {
  text,
  type: 'p2mr',
  providerContext: context,
  signatureBudget: {
    required: 1,
    cached: 0,
    remainingBefore: 100,
    remainingAfter: 99,
    limit: 1073741824
  }
} as any;
const onClickSign = vi.fn();
const confirmQbitRestoredFloorSigning = vi.fn();

const restoredMessage = (challengeId = 'challenge-7') =>
  ({
    ...toSignMessage,
    signatureBudget: {
      ...toSignMessage.signatureBudget,
      restoredFloorRisk: {
        recoveryStatus: 'seed-only-restored',
        counterConfidence: 'chain-floor-only',
        knownOnChainSignatures: 7,
        challengeId
      }
    }
  } as any);

function signMessageLogic(currentToSignMessage = toSignMessage) {
  return {
    loading: false,
    t: (key: string, substitutions?: string | string[]) =>
      substitutions === undefined
        ? key
        : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`,
    session: { origin: context.origin, icon: '', name: 'Approval' },
    isColdWalletSigning: false,
    showMultiSignView: false,
    disclaimerVisible: false,
    toSignMessages: [currentToSignMessage],
    currentToSignMessage,
    isScammer: false,
    allowQuickMultiSign: false,
    isAllSigned: false,
    signedCount: 0,
    multiSignList: [],
    onClickBack: vi.fn(),
    onClickSign,
    onQuickMultiSign: vi.fn(),
    onTryMultiSign: vi.fn(),
    onTrustSite: vi.fn(),
    onColdWalletSigningSuccess: vi.fn(),
    onColdWalletSigningBack: vi.fn(),
    readonlySignature: '',
    setReadonlySignature: vi.fn(),
    onDisclaimerModalClose: vi.fn()
  } as any;
}

describe('SignMessage Qbit provider approval details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCurrentAccountCapabilities).mockReturnValue({ signMethod: 'local' } as any);
    vi.mocked(useI18n).mockReturnValue({
      t: (key: string, substitutions?: string | string[]) =>
        substitutions === undefined
          ? key
          : `${key}:${Array.isArray(substitutions) ? substitutions.join(',') : substitutions}`
    } as any);
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({ confirmQbitRestoredFloorSigning } as any);
    vi.mocked(useSignMessageLogic).mockReturnValue(signMessageLogic());
  });

  afterEach(cleanup);

  it('shows the exact P2MR message bytes, context, and signature-budget impact', () => {
    render(
      <SignMessage
        params={{
          data: { toSignMessages: [toSignMessage] },
          context,
          session: { origin: context.origin, icon: '', name: 'Approval' }
        }}
      />
    );

    const contextCard = within(screen.getByTestId('qbit-provider-context'));
    expect(contextCard.getByText(context.origin)).not.toBeNull();
    expect(contextCard.getByText(context.account)).not.toBeNull();
    expect(contextCard.getByText(context.chain)).not.toBeNull();
    expect(contextCard.getByText(context.network)).not.toBeNull();
    expect(screen.getByTestId('p2mr-message-text').textContent).toBe(text);
    expect(screen.getByText('P2MR message proof v1')).not.toBeNull();
    expect(screen.getByText(`UTF-8 message bytes: ${new TextEncoder().encode(text).length}`)).not.toBeNull();
    expect(screen.getByText('New signatures: 1; cached: 0')).not.toBeNull();
    expect(screen.getByText('Signature budget: 100 before, 99 after')).not.toBeNull();
  });

  it('requires an exact restored-floor confirmation and never presents an exact remaining budget', async () => {
    const message = restoredMessage();
    vi.mocked(useSignMessageLogic).mockReturnValue(signMessageLogic(message));

    render(
      <SignMessage
        params={{
          data: { toSignMessages: [message] },
          context,
          session: { origin: context.origin, icon: '', name: 'Approval' }
        }}
      />
    );

    expect(screen.getByTestId('qbit-restored-floor-signing-warning')).toBeTruthy();
    expect(screen.getByText('qbit_recovery_status_seed_only')).toBeTruthy();
    expect(screen.getByText('qbit_counter_confidence_chain_floor_only')).toBeTruthy();
    expect(screen.getByText('qbit_known_onchain_usage_lower_bound:7+')).toBeTruthy();
    expect(screen.queryByText('Signature budget: 100 before, 99 after')).toBeNull();
    const signButton = screen.getByTestId('sign-message-button') as HTMLButtonElement;
    expect(signButton.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
    expect(signButton.disabled).toBe(false);
    fireEvent.click(signButton);

    await waitFor(() => expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledWith('challenge-7'));
    expect(onClickSign).toHaveBeenCalledTimes(1);
  });

  describe('restored-floor single-flight signing', () => {
    beforeEach(() => {
      confirmQbitRestoredFloorSigning.mockReset();
    });

    const renderRestored = (message = restoredMessage()) => {
      vi.mocked(useSignMessageLogic).mockReturnValue(signMessageLogic(message));
      return render(
        <SignMessage
          params={{
            data: { toSignMessages: [message] },
            context,
            session: { origin: context.origin, icon: '', name: 'Approval' }
          }}
        />
      );
    };

    it('confirms and signs once when the sign button is double-clicked in one update', async () => {
      let resolveConfirm!: () => void;
      confirmQbitRestoredFloorSigning.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
      );
      renderRestored();

      fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
      const signButton = screen.getByTestId('sign-message-button') as HTMLButtonElement;
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
    });

    it('re-arms the sign button after a failed confirmation so it can be retried', async () => {
      const toastError = vi.fn();
      vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError } as any);
      confirmQbitRestoredFloorSigning.mockRejectedValueOnce(new Error('confirmation expired'));
      renderRestored();

      fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
      const signButton = screen.getByTestId('sign-message-button') as HTMLButtonElement;
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
      renderRestored();

      fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
      fireEvent.click(screen.getByTestId('sign-message-button'));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith('qbit_recovery_signing_confirmation_expired')
      );
      expect(toastError).not.toHaveBeenCalledWith('[object Object]');
    });

    it('does not launch signing when the approval is rejected while confirmation is pending', async () => {
      const logic = signMessageLogic(restoredMessage());
      vi.mocked(useSignMessageLogic).mockReturnValue(logic);
      let resolveConfirm!: () => void;
      confirmQbitRestoredFloorSigning.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
      );
      render(
        <SignMessage
          params={{
            data: { toSignMessages: [restoredMessage()] },
            context,
            session: { origin: context.origin, icon: '', name: 'Approval' }
          }}
        />
      );

      fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
      fireEvent.click(screen.getByTestId('sign-message-button'));
      fireEvent.click(screen.getByText('reject'));
      expect(logic.onClickBack).toHaveBeenCalledTimes(1);

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
      const { unmount } = renderRestored();

      fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
      fireEvent.click(screen.getByTestId('sign-message-button'));
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
      const { rerender } = renderRestored(restoredMessage('challenge-7'));

      fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
      fireEvent.click(screen.getByTestId('sign-message-button'));
      expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(1);

      // The next item arrives with its own one-shot challenge while the
      // first confirmation is still pending.
      const nextMessage = restoredMessage('challenge-8');
      vi.mocked(useSignMessageLogic).mockReturnValue(signMessageLogic(nextMessage));
      rerender(
        <SignMessage
          params={{
            data: { toSignMessages: [nextMessage] },
            context,
            session: { origin: context.origin, icon: '', name: 'Approval' }
          }}
        />
      );

      await act(async () => {
        resolveFirstConfirm();
      });
      expect(onClickSign).not.toHaveBeenCalled();

      const signButton = screen.getByTestId('sign-message-button') as HTMLButtonElement;
      expect(signButton.disabled).toBe(true);
      fireEvent.click(screen.getByTestId('qbit-restored-floor-signing-confirmation'));
      confirmQbitRestoredFloorSigning.mockResolvedValueOnce(undefined);
      fireEvent.click(signButton);

      await waitFor(() => expect(onClickSign).toHaveBeenCalledTimes(1));
      expect(confirmQbitRestoredFloorSigning).toHaveBeenCalledTimes(2);
      expect(confirmQbitRestoredFloorSigning).toHaveBeenLastCalledWith('challenge-8');
    });
  });
});
