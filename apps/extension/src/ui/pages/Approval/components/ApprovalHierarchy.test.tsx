import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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

vi.mock('@/ui/components/AutoFitVirtualList', async () => {
  const React = await import('react');
  return {
    AutoFitVirtualList: ({ data, children }: { data: unknown[]; children: (item: any, index: number) => ReactNode }) =>
      React.createElement(
        'div',
        { 'data-testid': 'psbt-batch-list' },
        data.map((item, index) => React.createElement('div', { key: index }, children(item, index)))
      )
  };
});
vi.mock('@/ui/components/ColdWallet', () => ({ ColdWalletSignMessage: () => null }));
vi.mock('@/ui/components/ColdWallet/ColdWalletSignPsbt', () => ({ default: () => null }));
vi.mock('@/ui/components/PhishingDetection', () => ({ PhishingDetection: () => null }));
vi.mock('@/ui/components/SignPsbtWithRisksPopover', () => ({ SignPsbtWithRisksPopover: () => null }));
vi.mock('@/ui/components/WebsiteBar', () => ({ default: () => null }));
vi.mock('@/ui/theme/colors', () => ({
  colors: { border: '', surface: '', warning_bg: '#fff4cc', warning_content: '#f4b62c' }
}));
vi.mock('@/ui/theme/font', () => ({ fontSizes: { sm: 14, xxxl: 32 } }));
vi.mock('@/ui/utils', () => ({
  shortAddress: (address: string) => address,
  walletErrorMessage: (error: unknown) => String(error)
}));
vi.mock('@qbit/base-utils', () => ({ numUtils: { satoshisToAmount: () => '0' } }));

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

vi.mock('@/ui/pages/Approval/components/SignPsbt/components/ActionOverviewSection', async () => {
  const React = await import('react');
  return { default: () => React.createElement('div', { 'data-testid': 'psbt-action-overview' }) };
});
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/TransactionOverviewSection', async () => {
  const React = await import('react');
  return { default: () => React.createElement('div', { 'data-testid': 'psbt-transaction-overview' }) };
});
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/InputsList', async () => {
  const React = await import('react');
  return { InputsList: () => React.createElement('div', { 'data-testid': 'psbt-inputs' }) };
});
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/MultiSignDisclaimerModal', () => ({ default: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/OutputsList', () => ({ OutputsList: () => null }));
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/PsbtDataSection', async () => {
  const React = await import('react');
  return { default: () => React.createElement('div', { 'data-testid': 'psbt-data' }) };
});
vi.mock('@/ui/pages/Approval/components/SignPsbt/components/Section', async () => {
  const React = await import('react');
  return {
    SignPsbtSection: ({ title, children }: { title: string; children?: ReactNode }) =>
      React.createElement('div', null, React.createElement('span', null, title), children)
  };
});

const session = {
  origin: 'https://example.test',
  icon: '',
  name: 'Example'
};

const context = {
  origin: session.origin,
  account: 'qbrt1zapprovalaccount',
  chain: 'QBIT_TESTNET4',
  network: 'testnet4'
} as any;

const toSignData: any = {
  psbtHex: 'private-psbt',
  toSignInputs: [],
  action: 'send',
  providerContext: context
};

const toSignMessage: any = {
  text: 'Message to sign',
  type: 'p2mr',
  providerContext: context,
  signatureBudget: {
    required: 1,
    cached: 0,
    remainingBefore: 100,
    remainingAfter: 99,
    limit: 1073741824
  }
};

function unverifiedCheck(overrides: Record<string, unknown> = {}): ReturnType<typeof useConnectWebsiteCheck> {
  return {
    status: 'unverified',
    warning: '',
    retry: vi.fn(),
    result: undefined,
    guardVersionRef: { current: 0 },
    blockedRef: { current: false },
    ...overrides
  } as unknown as ReturnType<typeof useConnectWebsiteCheck>;
}

function createSignMessageLogicResult(overrides: Record<string, unknown> = {}): ReturnType<typeof useSignMessageLogic> {
  return {
    loading: false,
    t: (key: string) => key,
    session,
    isColdWalletSigning: false,
    showMultiSignView: false,
    disclaimerVisible: false,
    toSignMessages: [toSignMessage],
    currentToSignMessage: toSignMessage,
    websiteCheckStatus: 'unverified',
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
    websiteCheckStatus: 'unverified',
    websiteCheckWarning: '',
    isPsbtRiskPopoverVisible: false,
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

/** Asserts `earlier` precedes `later` in DOM order (what a reader sees first). */
function expectBefore(earlier: Element, later: Element) {
  expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
}

function expectOrder(...elements: Element[]) {
  for (let index = 1; index < elements.length; index += 1) {
    expectBefore(elements[index - 1], elements[index]);
  }
}

function expectSharedCompactWarning(prefix: '' | 'psbt-' | 'message-') {
  const warning = screen.getByTestId(`${prefix}website-check-warning`);
  expect(warning.getAttribute('role')).toBe('alert');
  expect(warning.style.backgroundColor).toBe('rgb(255, 244, 204)');
  expect(warning.style.border).toContain('rgb(244, 182, 44)');
  expect(screen.getByTestId(`${prefix}website-check-error`).textContent).toBe('website_check_failed');
  const retry = screen.getByTestId(`${prefix}website-check-retry-button`);
  expect(retry.tagName).toBe('BUTTON');
  expect(retry).toBe(screen.getByRole('button', { name: 'try_again' }));
  return warning;
}

describe('approval hierarchy: payload before provider metadata', () => {
  const approval = {
    resolveApproval: vi.fn(),
    rejectApproval: vi.fn()
  };

  beforeEach(() => {
    vi.mocked(useApproval).mockReturnValue(approval as any);
    vi.mocked(useConnectWebsiteCheck).mockReturnValue(unverifiedCheck());
    vi.mocked(useI18n).mockReturnValue({ t: (key: string) => key } as any);
    vi.mocked(useCurrentAccount).mockReturnValue({ address: 'bc1qexample', alianName: 'Account 1' } as any);
    vi.mocked(useCurrentKeyring).mockReturnValue({ alianName: 'Wallet 1' } as any);
    vi.mocked(useCurrentAccountCapabilities).mockReturnValue({ signMethod: AccountSignMethod.Local } as any);
    vi.mocked(useQbitUnit).mockReturnValue('QBIT');
    vi.mocked(useSignMessageLogic).mockReturnValue(createSignMessageLogicResult());
    vi.mocked(useSignPsbtLogic).mockReturnValue(createSignPsbtLogicResult());
    vi.mocked(useTools).mockReturnValue({ copyToClipboard: vi.fn(), toastError: vi.fn() } as any);
    vi.mocked(useWallet).mockReturnValue({ confirmQbitRestoredFloorSigning: vi.fn() } as any);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Connect', () => {
    it('renders the compact warning, the connect copy and selected account, then provider metadata', () => {
      render(<Connect params={{ data: { context }, session }} />);

      const warning = expectSharedCompactWarning('');
      const account = screen.getByTestId('connect-account-item');
      expect(within(account).getByText('Account 1')).not.toBeNull();
      expectOrder(
        warning,
        screen.getByText('Connect with Qbit Wallet'),
        screen.getByText('select_the_account_to_use_on_this_site'),
        screen.getByText('Wallet 1'),
        account,
        screen.getByTestId('qbit-provider-context')
      );
    });

    it('never enables Connect from Retry and requires a fresh acknowledgement after the check restarts', () => {
      const retry = vi.fn();
      let status = 'unverified';
      vi.mocked(useConnectWebsiteCheck).mockImplementation(() =>
        unverifiedCheck({
          get status() {
            return status;
          },
          retry
        })
      );
      const { rerender } = render(<Connect params={{ session }} />);
      const connectButton = () => screen.getByTestId('website-check-connect-button') as HTMLButtonElement;

      expect(connectButton().disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'try_again' }));
      expect(retry).toHaveBeenCalledTimes(1);
      expect(connectButton().disabled).toBe(true);
      fireEvent.click(connectButton());
      expect(approval.resolveApproval).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('unverified-website-confirmation-input'));
      expect(connectButton().disabled).toBe(false);

      // Retry restarts the check; when the unverified verdict comes back the
      // earlier acknowledgement no longer counts.
      status = 'checking';
      rerender(<Connect params={{ session }} />);
      expect(screen.getByTestId('website-check-loading-cancel-button')).not.toBeNull();
      expect(screen.queryByTestId('website-check-connect-button')).toBeNull();

      status = 'unverified';
      rerender(<Connect params={{ session }} />);
      expect(connectButton().disabled).toBe(true);
      expect((screen.getByTestId('unverified-website-confirmation-input') as HTMLInputElement).checked).toBe(false);
      expect(approval.resolveApproval).not.toHaveBeenCalled();
    });
  });

  describe('SignPsbt', () => {
    it('renders the warning, action overview, provider metadata, then the technical details', () => {
      render(<SignPsbt params={{ data: { toSignDatas: [toSignData] }, session }} />);

      const warning = expectSharedCompactWarning('psbt-');
      expectOrder(
        warning,
        screen.getByTestId('psbt-action-overview'),
        screen.getByTestId('qbit-provider-context'),
        screen.getByText('transaction_details'),
        screen.getByTestId('psbt-inputs'),
        screen.getByTestId('psbt-transaction-overview'),
        screen.getByTestId('psbt-data')
      );
      expect(screen.getByTestId('psbt-unverified-website-confirmation')).not.toBeNull();
      expect((screen.getByTestId('sign-psbt-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('renders the batch title, count and transaction list before provider metadata', () => {
      const toSignDatas = [toSignData, { ...toSignData, psbtHex: 'second-private-psbt' }];
      vi.mocked(useSignPsbtLogic).mockReturnValue(
        createSignPsbtLogicResult({
          showMultiSignView: true,
          toSignDatas,
          currentToSignData: undefined,
          currentDecodedPsbt: undefined,
          isValid: false,
          localPsbtSummary: { parseErrorCount: 0, hasSighashNone: false },
          multiSignList: toSignDatas.map((_, index) => ({
            index,
            buttonText: 'sign',
            buttonPreset: 'primary',
            psbtInfo: undefined,
            onClick: vi.fn()
          }))
        })
      );

      render(<SignPsbt params={{ data: { toSignDatas }, context, session }} />);

      const warning = expectSharedCompactWarning('psbt-');
      const list = screen.getByTestId('psbt-batch-list');
      expect(within(list).getByText('transaction 1')).not.toBeNull();
      expectOrder(
        warning,
        screen.getByText('sign_multiple_transactions'),
        screen.getByTestId('qbit-provider-batch-review-required'),
        screen.getByText('transaction_count: 2'),
        list,
        screen.getByTestId('qbit-provider-context')
      );
    });
  });

  describe('SignMessage', () => {
    it('renders the warning, request heading, exact message, provider metadata, then the signature budget', () => {
      render(<SignMessage params={{ data: { toSignMessages: [toSignMessage] }, context, session }} />);

      const warning = expectSharedCompactWarning('message-');
      const message = screen.getByTestId('p2mr-message-text');
      expect(message.textContent).toBe(toSignMessage.text);
      expectOrder(
        warning,
        screen.getByText('signature_request'),
        screen.getByText('only_sign_this_message_if_you_fully_understand_the'),
        screen.getByText('you_are_signing'),
        message,
        screen.getByTestId('qbit-provider-context'),
        screen.getByTestId('p2mr-message-signature-budget')
      );
      expect((screen.getByTestId('sign-message-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps the batch title and message list as the primary content without provider metadata', () => {
      const messages = [toSignMessage, { ...toSignMessage, text: 'Second message' }];
      vi.mocked(useSignMessageLogic).mockReturnValue(
        createSignMessageLogicResult({
          showMultiSignView: true,
          toSignMessages: messages,
          currentToSignMessage: undefined,
          multiSignList: messages.map((message) => ({
            title: message.text,
            buttonText: 'sign',
            buttonPreset: 'primary',
            onClick: vi.fn()
          }))
        })
      );

      render(<SignMessage params={{ data: { toSignMessages: messages }, context, session }} />);

      const warning = expectSharedCompactWarning('message-');
      expectOrder(
        warning,
        screen.getByText('sign_multiple_transactions'),
        screen.getByText('message 1'),
        screen.getByText('Message to sign'),
        screen.getByText('message 2')
      );
      expect(screen.queryByTestId('qbit-provider-context')).toBeNull();
      expect((screen.getByText('(0/2) signed') as HTMLButtonElement).disabled).toBe(true);
    });

    it('never enables Sign from Retry and clears the acknowledgement when the check restarts', () => {
      const onClickSign = vi.fn();
      const onRetryWebsiteCheck = vi.fn();
      vi.mocked(useSignMessageLogic).mockReturnValue(
        createSignMessageLogicResult({ onClickSign, onRetryWebsiteCheck })
      );

      render(<SignMessage params={{ data: { toSignMessages: [toSignMessage] }, session }} />);

      const signButton = screen.getByTestId('sign-message-button') as HTMLButtonElement;
      const retry = screen.getByRole('button', { name: 'try_again' });
      expect(signButton.disabled).toBe(true);

      fireEvent.click(retry);
      expect(onRetryWebsiteCheck).toHaveBeenCalledTimes(1);
      expect(signButton.disabled).toBe(true);
      fireEvent.click(signButton);
      expect(onClickSign).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('message-unverified-website-confirmation-input'));
      expect(signButton.disabled).toBe(false);

      fireEvent.click(retry);
      expect(onRetryWebsiteCheck).toHaveBeenCalledTimes(2);
      expect(signButton.disabled).toBe(true);
      expect((screen.getByTestId('message-unverified-website-confirmation-input') as HTMLInputElement).checked).toBe(
        false
      );
      expect(onClickSign).not.toHaveBeenCalled();
    });
  });
});
