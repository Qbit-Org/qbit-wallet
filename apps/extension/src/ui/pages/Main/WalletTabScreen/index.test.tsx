import type { CSSProperties, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyringType } from '@qbit/keyring-service/types';
import { BUS_METHODS } from '@qbit/wallet-shared';
import {
  uiEventBus,
  useChain,
  useCurrentAccount,
  useCurrentKeyring,
  useIsUnlocked,
  useNavigation,
  useSkipVersionCallback,
  useTools,
  useVersionInfo,
  useWallet
} from '@qbit/wallet-state';

import WalletTabScreen from './index';

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
  const Header = ({ LeftComponent, RightComponent }: { LeftComponent?: ReactNode; RightComponent?: ReactNode }) =>
    React.createElement('header', null, LeftComponent, RightComponent);
  const Text = ({ text }: { text?: string }) => React.createElement('span', null, text);
  const Icon = ({ icon }: { icon?: string }) => React.createElement('span', { 'data-icon': icon });
  const Tooltip = ({ children }: { children?: ReactNode }) => React.createElement(React.Fragment, null, children);
  return {
    Card: Container,
    Column: Container,
    Content: Container,
    Footer: Container,
    Header,
    Icon,
    Layout: Container,
    Row: Container,
    Text,
    Tooltip
  };
});

vi.mock('@/ui/components/AccountSelect', () => ({ default: () => null }));
vi.mock('@/ui/components/FeeRateIcon', () => ({ FeeRateIcon: () => null }));
vi.mock('@/ui/components/LoadingPage', () => ({ default: () => null }));
vi.mock('@/ui/components/NavTabBar', () => ({ NavTabBar: () => null }));
vi.mock('@/ui/components/SwitchNetworkBar', () => ({ SwitchNetworkBar: () => null }));
vi.mock('@/ui/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/ui/components/UpgradePopover', () => ({ UpgradePopover: () => null }));
vi.mock('@/ui/components/VersionNotice', async () => {
  const React = await import('react');
  return {
    VersionNotice: ({ notice, onClose }: { notice: { title: string }; onClose(): void }) =>
      React.createElement(
        'div',
        { 'data-testid': 'version-notice' },
        React.createElement('span', { 'data-testid': 'version-notice-title' }, notice.title),
        React.createElement('button', { onClick: onClose, 'data-testid': 'version-notice-close' }, 'Got it')
      )
  };
});
vi.mock('@/ui/web/tabs', () => ({ getCurrentTab: vi.fn(async () => undefined) }));
vi.mock('../../MainRoute', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../Settings/SwitchChainModal', () => ({ SwitchChainModal: () => null }));
vi.mock('./SidePanelExpand', () => ({ SidePanelExpand: () => null }));
vi.mock('./components/AnnouncementCard', () => ({ AnnouncementCard: () => null }));
vi.mock('./components/BalanceCard', () => ({ BalanceCard: () => null }));
vi.mock('./components/HomeTips', () => ({ HomeTips: () => null }));
vi.mock('./components/WalletActions', async () => {
  const React = await import('react');
  return {
    WalletActions: ({ hideReceive }: { hideReceive?: boolean }) =>
      React.createElement('div', {
        'data-testid': 'wallet-actions',
        'data-hide-receive': hideReceive ? 'true' : 'false'
      })
  };
});
vi.mock('./components/QbitRecoveryWarning', async () => {
  const React = await import('react');
  return {
    QbitRecoveryWarning: ({
      state,
      accepted,
      onAcceptedChange,
      onAcknowledge,
      onDismiss
    }: {
      state: {
        status: string;
        acknowledgement: string;
        knownOnChainSignatures: number;
        warningDismissed?: boolean;
      };
      accepted: boolean;
      onAcceptedChange(accepted: boolean): void;
      onAcknowledge(): void;
      onDismiss(): void;
    }) => {
      // Internal UI state standing in for the real component's collapsed /
      // expanded banner; the parent must reset it per keyring via a remount.
      const [expanded, setExpanded] = React.useState(false);
      return React.createElement(
        'div',
        null,
        React.createElement('input', {
          type: 'checkbox',
          checked: accepted,
          onChange: (event: { target: { checked: boolean } }) => onAcceptedChange(event.target.checked),
          'data-testid': 'continued-use'
        }),
        React.createElement('span', { 'data-testid': 'known-signatures' }, state.knownOnChainSignatures),
        React.createElement('span', { 'data-testid': 'recovery-status' }, state.status),
        React.createElement('span', { 'data-testid': 'recovery-acknowledgement' }, state.acknowledgement),
        React.createElement(
          'span',
          { 'data-testid': 'recovery-dismissed' },
          state.warningDismissed === true ? 'dismissed' : 'visible'
        ),
        React.createElement('span', { 'data-testid': 'banner-expanded' }, expanded ? 'expanded' : 'collapsed'),
        React.createElement(
          'button',
          { onClick: () => setExpanded((value: boolean) => !value), 'data-testid': 'toggle-banner' },
          'toggle'
        ),
        React.createElement('button', { onClick: onAcknowledge, 'data-testid': 'acknowledge' }, 'acknowledge'),
        React.createElement('button', { onClick: onDismiss, 'data-testid': 'dismiss' }, 'dismiss')
      );
    }
  };
});

vi.mock('@qbit/wallet-state', () => {
  const listeners: Record<string, Array<(params?: unknown) => void>> = {};
  return {
    uiEventBus: {
      addEventListener: (type: string, fn: (params?: unknown) => void) => {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener: (type: string, fn: (params?: unknown) => void) => {
        listeners[type] = (listeners[type] || []).filter((item) => item !== fn);
      },
      emit: (type: string, params?: unknown) => {
        (listeners[type] || []).forEach((fn) => fn(params));
      }
    },
    useChain: vi.fn(),
    useCurrentAccount: vi.fn(),
    useCurrentKeyring: vi.fn(),
    useI18n: vi.fn(() => ({ t: (key: string) => key })),
    useIsUnlocked: vi.fn(),
    useNavigation: vi.fn(),
    useSkipVersionCallback: vi.fn(),
    useTools: vi.fn(),
    useVersionInfo: vi.fn(),
    useWallet: vi.fn()
  };
});

const seedOnlyRecovery = {
  status: 'seed-only-restored',
  acknowledgement: 'required',
  counterConfidence: 'chain-floor-only',
  knownOnChainSignatures: 4
} as any;

function recoveredKeyring(recovery = seedOnlyRecovery, overrides: Record<string, unknown> = {}) {
  return {
    key: 'keyring-2',
    index: 2,
    type: KeyringType.QbitHdKeyring,
    alianName: 'Recovered wallet',
    accounts: [{ address: 'qbrt1qrecovered', pubkey: 'anchor-pubkey-2' }],
    qbitRecovery: recovery,
    ...overrides
  } as any;
}

describe('WalletTabScreen recovery acceptance', () => {
  let walletMock: {
    getNotifications: ReturnType<typeof vi.fn>;
    getCurrentConnectedSite: ReturnType<typeof vi.fn>;
    getQbitRecoveryState: ReturnType<typeof vi.fn>;
    acknowledgeQbitRecoveryRisk: ReturnType<typeof vi.fn>;
    dismissQbitRecoveryWarning: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.0' }));
    walletMock = {
      getNotifications: vi.fn(),
      getCurrentConnectedSite: vi.fn(),
      getQbitRecoveryState: vi.fn(async () => seedOnlyRecovery),
      acknowledgeQbitRecoveryRisk: vi.fn(),
      dismissQbitRecoveryWarning: vi.fn()
    };
    vi.mocked(useChain).mockReturnValue({} as any);
    vi.mocked(useCurrentAccount).mockReturnValue({ address: 'qbrt1qrecovered' } as any);
    vi.mocked(useCurrentKeyring).mockReturnValue(recoveredKeyring());
    vi.mocked(useIsUnlocked).mockReturnValue(true);
    vi.mocked(useNavigation).mockReturnValue({ navToLock: vi.fn() } as any);
    vi.mocked(useSkipVersionCallback).mockReturnValue(vi.fn());
    vi.mocked(useTools).mockReturnValue({ toastError: vi.fn() } as any);
    vi.mocked(useVersionInfo).mockReturnValue({
      currentVesion: '1.0.0',
      skipped: true,
      newVersion: '1.0.0'
    } as any);
    vi.mocked(useWallet).mockReturnValue(walletMock as any);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('keeps explicit acceptance across display refreshes and resets it for a lifecycle change', async () => {
    const { rerender } = render(<WalletTabScreen />);
    const checkbox = await screen.findByTestId('continued-use');

    fireEvent.click(checkbox);
    expect((screen.getByTestId('continued-use') as HTMLInputElement).checked).toBe(true);

    vi.mocked(useCurrentKeyring).mockReturnValue(recoveredKeyring({ ...seedOnlyRecovery, knownOnChainSignatures: 5 }));
    rerender(<WalletTabScreen />);

    await waitFor(() => expect(screen.getByTestId('known-signatures').textContent).toBe('5'));
    expect((screen.getByTestId('continued-use') as HTMLInputElement).checked).toBe(true);

    vi.mocked(useCurrentKeyring).mockReturnValue(recoveredKeyring({ ...seedOnlyRecovery, status: 'migrating' }));
    rerender(<WalletTabScreen />);

    await waitFor(() => expect((screen.getByTestId('continued-use') as HTMLInputElement).checked).toBe(false));
  });

  it('keeps wallet actions after archival but hides the receive option', async () => {
    const migrating = { ...seedOnlyRecovery, status: 'migrating' };
    vi.mocked(useCurrentKeyring).mockReturnValue(recoveredKeyring(migrating));
    walletMock.getQbitRecoveryState.mockResolvedValue(migrating);
    const { rerender } = render(<WalletTabScreen />);

    expect((await screen.findByTestId('wallet-actions')).getAttribute('data-hide-receive')).toBe('false');
    await waitFor(() => expect(screen.getByTestId('recovery-status').textContent).toBe('migrating'));

    const migrated = { ...seedOnlyRecovery, status: 'migrated' };
    vi.mocked(useCurrentKeyring).mockReturnValue(recoveredKeyring(migrated));
    walletMock.getQbitRecoveryState.mockResolvedValue(migrated);
    rerender(<WalletTabScreen />);

    await waitFor(() => expect(screen.getByTestId('wallet-actions').getAttribute('data-hide-receive')).toBe('true'));
  });

  it('shows the acknowledged state after navigating away and remounting with a stale keyring snapshot', async () => {
    const acknowledged = { ...seedOnlyRecovery, acknowledgement: 'accepted' };
    walletMock.acknowledgeQbitRecoveryRisk.mockResolvedValue(acknowledged);

    const { unmount } = render(<WalletTabScreen />);
    fireEvent.click(await screen.findByTestId('acknowledge'));
    // The acknowledgement must carry the anchor identity so the background can
    // re-resolve the wallet if keyring compaction moved it to another index.
    expect(walletMock.acknowledgeQbitRecoveryRisk).toHaveBeenCalledWith(2, 'anchor-pubkey-2');
    await waitFor(() => expect(screen.getByTestId('recovery-acknowledgement').textContent).toBe('accepted'));

    unmount();

    // The background now reports the acknowledged state, while the redux
    // keyring snapshot still carries the pre-acknowledgement data.
    walletMock.getQbitRecoveryState.mockResolvedValue(acknowledged);
    render(<WalletTabScreen />);

    await waitFor(() => expect(screen.getByTestId('recovery-acknowledgement').textContent).toBe('accepted'));
  });

  it('persists a permanent dismissal with the anchor identity and shows the dismissed state', async () => {
    const acknowledged = { ...seedOnlyRecovery, acknowledgement: 'accepted' };
    walletMock.getQbitRecoveryState.mockResolvedValue(acknowledged);
    walletMock.dismissQbitRecoveryWarning.mockResolvedValue({ ...acknowledged, warningDismissed: true });

    render(<WalletTabScreen />);
    await waitFor(() => expect(screen.getByTestId('recovery-acknowledgement').textContent).toBe('accepted'));

    fireEvent.click(screen.getByTestId('dismiss'));
    expect(walletMock.dismissQbitRecoveryWarning).toHaveBeenCalledWith(2, 'anchor-pubkey-2');
    await waitFor(() => expect(screen.getByTestId('recovery-dismissed').textContent).toBe('dismissed'));
  });

  it('drops a dismissal response that resolves after a keyring switch', async () => {
    let resolveDismiss: (state: unknown) => void = () => undefined;
    walletMock.dismissQbitRecoveryWarning.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDismiss = resolve;
        })
    );

    const { rerender } = render(<WalletTabScreen />);
    fireEvent.click(await screen.findByTestId('dismiss'));

    vi.mocked(useCurrentKeyring).mockReturnValue(recoveredKeyring(seedOnlyRecovery, { key: 'keyring-3', index: 3 }));
    rerender(<WalletTabScreen />);
    await waitFor(() => expect(screen.getByTestId('recovery-dismissed').textContent).toBe('visible'));

    await act(async () => {
      resolveDismiss({ ...seedOnlyRecovery, acknowledgement: 'accepted', warningDismissed: true });
    });

    expect(screen.getByTestId('recovery-dismissed').textContent).toBe('visible');
  });

  it('collapses the banner again when switching to another recovered wallet', async () => {
    const { rerender } = render(<WalletTabScreen />);

    fireEvent.click(await screen.findByTestId('toggle-banner'));
    expect(screen.getByTestId('banner-expanded').textContent).toBe('expanded');

    vi.mocked(useCurrentKeyring).mockReturnValue(recoveredKeyring(seedOnlyRecovery, { key: 'keyring-3', index: 3 }));
    rerender(<WalletTabScreen />);

    await waitFor(() => expect(screen.getByTestId('banner-expanded').textContent).toBe('collapsed'));
  });

  it('shows migration progress when returning home while a migration is running', async () => {
    walletMock.getQbitRecoveryState.mockResolvedValue({
      ...seedOnlyRecovery,
      status: 'migrating',
      acknowledgement: 'accepted'
    });
    render(<WalletTabScreen />);

    await waitFor(() => expect(screen.getByTestId('recovery-status').textContent).toBe('migrating'));
    expect(await screen.findByTestId('wallet-actions')).toBeTruthy();
  });

  it('refreshes recovery state when the background broadcasts an account change', async () => {
    render(<WalletTabScreen />);
    await waitFor(() => expect(screen.getByTestId('recovery-acknowledgement').textContent).toBe('required'));

    walletMock.getQbitRecoveryState.mockResolvedValue({ ...seedOnlyRecovery, status: 'migrating' });
    await act(async () => {
      (uiEventBus as unknown as { emit(type: string): void }).emit(BUS_METHODS.ACCOUNTS_CHANGED);
    });

    await waitFor(() => expect(screen.getByTestId('recovery-status').textContent).toBe('migrating'));
    // The refresh resolves the wallet by its anchor identity: keyring removal
    // compacts indexes, and the captured index alone could load another
    // wallet's lifecycle after a compaction.
    expect(walletMock.getQbitRecoveryState).toHaveBeenLastCalledWith(2, 'anchor-pubkey-2');
  });

  it('ignores a late recovery response after switching keyrings', async () => {
    let resolveFirst: (state: unknown) => void = () => undefined;
    const firstRequest = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    walletMock.getQbitRecoveryState.mockImplementation((index: number) =>
      index === 2 ? firstRequest : Promise.resolve({ ...seedOnlyRecovery, knownOnChainSignatures: 9 })
    );

    const { rerender } = render(<WalletTabScreen />);

    vi.mocked(useCurrentKeyring).mockReturnValue(
      recoveredKeyring({ ...seedOnlyRecovery, knownOnChainSignatures: 7 }, { key: 'keyring-3', index: 3 })
    );
    rerender(<WalletTabScreen />);
    await waitFor(() => expect(screen.getByTestId('known-signatures').textContent).toBe('9'));

    await act(async () => {
      resolveFirst({ ...seedOnlyRecovery, status: 'migrating', knownOnChainSignatures: 4 });
    });

    expect(screen.getByTestId('known-signatures').textContent).toBe('9');
    expect(screen.getByTestId('recovery-status').textContent).toBe('seed-only-restored');
  });

  it('drops an acknowledgement response that resolves after a keyring switch', async () => {
    let resolveAck: (state: unknown) => void = () => undefined;
    walletMock.acknowledgeQbitRecoveryRisk.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAck = resolve;
        })
    );

    const { rerender } = render(<WalletTabScreen />);
    fireEvent.click(await screen.findByTestId('acknowledge'));

    vi.mocked(useCurrentKeyring).mockReturnValue(
      recoveredKeyring({ ...seedOnlyRecovery, knownOnChainSignatures: 7 }, { key: 'keyring-3', index: 3 })
    );
    rerender(<WalletTabScreen />);
    await waitFor(() => expect(screen.getByTestId('known-signatures').textContent).toBe('4'));

    await act(async () => {
      resolveAck({ ...seedOnlyRecovery, acknowledgement: 'accepted' });
    });

    expect(screen.getByTestId('recovery-acknowledgement').textContent).toBe('required');
  });

  it('hides the receive action when the authoritative state reports archival', async () => {
    vi.mocked(useCurrentKeyring).mockReturnValue(
      recoveredKeyring({ ...seedOnlyRecovery, status: 'migrating', acknowledgement: 'accepted' })
    );
    walletMock.getQbitRecoveryState.mockResolvedValue({
      ...seedOnlyRecovery,
      status: 'migrated',
      acknowledgement: 'accepted'
    });
    render(<WalletTabScreen />);

    await waitFor(() => expect(screen.getByTestId('wallet-actions').getAttribute('data-hide-receive')).toBe('true'));
    expect(screen.getByTestId('recovery-status').textContent).toBe('migrated');
  });
});

describe('WalletTabScreen lock wallet button', () => {
  let lockWallet: ReturnType<typeof vi.fn>;
  let navToLock: ReturnType<typeof vi.fn>;
  let toastError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.0' }));
    lockWallet = vi.fn(async () => undefined);
    navToLock = vi.fn();
    toastError = vi.fn();
    vi.mocked(useChain).mockReturnValue({} as any);
    vi.mocked(useCurrentAccount).mockReturnValue({ address: 'qbrt1qplain' } as any);
    vi.mocked(useCurrentKeyring).mockReturnValue({
      key: 'keyring-1',
      index: 1,
      type: KeyringType.HdKeyring,
      alianName: 'Main wallet',
      accounts: [{ address: 'qbrt1qplain', pubkey: 'pubkey-1' }]
    } as any);
    vi.mocked(useIsUnlocked).mockReturnValue(true);
    vi.mocked(useNavigation).mockReturnValue({ navToLock } as any);
    vi.mocked(useSkipVersionCallback).mockReturnValue(vi.fn());
    vi.mocked(useTools).mockReturnValue({ toastError } as any);
    vi.mocked(useVersionInfo).mockReturnValue({
      currentVesion: '1.0.0',
      skipped: true,
      newVersion: '1.0.0'
    } as any);
    vi.mocked(useWallet).mockReturnValue({
      getNotifications: vi.fn(),
      getCurrentConnectedSite: vi.fn(),
      lockWallet
    } as any);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('locks the wallet and navigates to the lock screen on click', async () => {
    render(<WalletTabScreen />);

    const button = screen.getByTestId('lock-wallet-button');
    expect(button.querySelector('[data-icon="lock"]')).toBeTruthy();

    fireEvent.click(button);

    expect(lockWallet).toHaveBeenCalledTimes(1);
    // Navigation waits for the lock call to settle so the lock state
    // propagates before the unlock screen mounts.
    expect(navToLock).not.toHaveBeenCalled();
    await waitFor(() => expect(navToLock).toHaveBeenCalledWith({ autoUnlockByFace: false }));
  });

  it('stays on main and surfaces a toast when lockWallet rejects', async () => {
    lockWallet.mockRejectedValue(new Error('lock failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(<WalletTabScreen />);

      fireEvent.click(screen.getByTestId('lock-wallet-button'));

      expect(lockWallet).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('failed_to_lock_wallet'));
      // Navigating while the wallet is still unlocked would bounce the unlock
      // screen straight back to main, so a failed lock must stay put.
      expect(navToLock).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith('LockWalletButton error:', expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('WalletTabScreen version notice', () => {
  let getVersionDetail: ReturnType<typeof vi.fn>;

  const noticeDetail = {
    version: '1.0.1',
    title: 'New in 1.0.1',
    changelogs: [],
    notice: 'Unlock with Touch ID\nFaster balance refresh'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getVersionDetail = vi.fn(async () => noticeDetail);
    vi.mocked(useChain).mockReturnValue({} as any);
    vi.mocked(useCurrentAccount).mockReturnValue({ address: 'qbrt1qplain' } as any);
    vi.mocked(useCurrentKeyring).mockReturnValue({
      key: 'keyring-1',
      index: 1,
      type: KeyringType.HdKeyring,
      alianName: 'Main wallet',
      accounts: [{ address: 'qbrt1qplain', pubkey: 'pubkey-1' }]
    } as any);
    vi.mocked(useIsUnlocked).mockReturnValue(true);
    vi.mocked(useNavigation).mockReturnValue({ navToLock: vi.fn() } as any);
    vi.mocked(useSkipVersionCallback).mockReturnValue(vi.fn());
    vi.mocked(useTools).mockReturnValue({ toastError: vi.fn() } as any);
    vi.mocked(useVersionInfo).mockReturnValue({
      currentVesion: '1.0.1',
      skipped: true,
      newVersion: '1.0.1'
    } as any);
    vi.mocked(useWallet).mockReturnValue({
      getNotifications: vi.fn(),
      getCurrentConnectedSite: vi.fn(),
      getVersionDetail
    } as any);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('shows the bundled notice after an update and caches only on dismissal', async () => {
    localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.0' }));

    render(<WalletTabScreen />);

    await waitFor(() => expect(screen.getByTestId('version-notice')).toBeTruthy());
    expect(getVersionDetail).toHaveBeenCalledWith('1.0.1');
    expect(screen.getByTestId('version-notice-title').textContent).toBe('New in 1.0.1');
    // Nothing is cached until the user dismisses, so an unread notice can reappear.
    expect(JSON.parse(localStorage.getItem('version_detail') || '{}').version).toBe('1.0.0');

    fireEvent.click(screen.getByTestId('version-notice-close'));
    expect(screen.queryByTestId('version-notice')).toBeNull();
    // The dismissal caches the detail so the popover cannot reappear for this version.
    expect(JSON.parse(localStorage.getItem('version_detail') || '{}').version).toBe('1.0.1');
  });

  it('seeds the cache silently on a fresh install without showing the notice', async () => {
    render(<WalletTabScreen />);

    await waitFor(() => expect(JSON.parse(localStorage.getItem('version_detail') || '{}').version).toBe('1.0.1'));
    // First-run users have no prior version to be updated from.
    expect(getVersionDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('version-notice')).toBeNull();
  });

  it('shows the notice again when the popup closed before it was dismissed', async () => {
    localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.0' }));

    const first = render(<WalletTabScreen />);
    await waitFor(() => expect(first.getByTestId('version-notice')).toBeTruthy());

    // Popup lost focus and closed: the component unmounts without a dismissal.
    first.unmount();
    expect(JSON.parse(localStorage.getItem('version_detail') || '{}').version).toBe('1.0.0');

    render(<WalletTabScreen />);
    await waitFor(() => expect(screen.getByTestId('version-notice')).toBeTruthy());
    expect(getVersionDetail).toHaveBeenCalledTimes(2);
  });

  it('skips the fetch entirely when the cached version matches', async () => {
    localStorage.setItem('version_detail', JSON.stringify(noticeDetail));

    render(<WalletTabScreen />);

    await waitFor(() => expect(vi.mocked(useWallet)().getNotifications).toHaveBeenCalled());
    expect(getVersionDetail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('version-notice')).toBeNull();
  });

  it('shows nothing for a version without bundled notice copy and caches immediately', async () => {
    localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.0' }));
    getVersionDetail.mockResolvedValue({ version: '1.0.1', title: '', changelogs: [], notice: '' });

    render(<WalletTabScreen />);

    await waitFor(() => expect(getVersionDetail).toHaveBeenCalledWith('1.0.1'));
    // With no notice to show there is nothing to dismiss, so the version caches right away.
    await waitFor(() => expect(JSON.parse(localStorage.getItem('version_detail') || '{}').version).toBe('1.0.1'));
    expect(screen.queryByTestId('version-notice')).toBeNull();
  });
});
