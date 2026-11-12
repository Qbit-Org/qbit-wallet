import type { ComponentType, ReactNode } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Layout } from '@/ui/components/Layout';
import {
  forgetInterruptedSendForm,
  getInterruptedSendForm,
  SEND_FORM_RETURN_FALLBACK_MS
} from '@/ui/utils/sendFormReturn';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LockWalletButton } from './Main/WalletTabScreen/LockWalletButton';
import Main from './MainRoute';

/*
 * The wallet's history in a tab, on jsdom's window.history: the app's own
 * router (Main, a HashRouter over the real route table and useNavigate, with
 * the real NavigationProvider and ApprovalProvider), the real start screen
 * (BoostScreen), unlock screen, Layout and lock button, and the unlock
 * screen's real way back to a send form a lock interrupted. Every other
 * screen is a stub; Home, Settings, the send form, the send confirm screen
 * and Welcome log when they are shown. Home, Settings, the send form and the
 * send confirm screen use the real Layout, which
 * sends a locked page to the unlock screen and remembers a send form shown
 * unlocked. Home and Settings show the real lock button, which locks and
 * then calls navToLock, as Settings' own lock does; Home also has
 * WalletTabScreen's own redirect on a lock.
 */

const page = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    unlocked: false,
    listeners,
    /** Screens shown, in order: 'unlock', 'home', 'settings', 'form', 'confirm', 'welcome'. */
    shown: [] as string[],
    /** The route state the unlock screen was last shown with. */
    unlockState: undefined as unknown,
    /** The real Layout and lock button, set once this file has loaded them. */
    Layout: undefined as unknown as ComponentType<{ children?: ReactNode }>,
    LockWalletButton: undefined as unknown as ComponentType,
    /** The background's answer to lockWallet; a test may hold it. */
    lockWallet: async () => undefined as void,
    /** The background's answer to hasVault; a test may hold it or say no. */
    hasVault: async () => true as boolean,
    /** The account the background has selected. */
    account: 'qbit-test-address',
    /** The background's answer to getChainType; a test may hold it. */
    chainType: async () => 'QBIT_MAINNET',
    /** The times the send form was cleared (Send starts it afresh). */
    formResets: 0,
    /** The website request pending in the background, and those rejected. */
    approval: undefined as undefined | { id: string; data: Record<string, unknown> },
    rejected: [] as string[],
    setUnlocked(unlocked: boolean) {
      this.unlocked = unlocked;
      listeners.forEach((listener) => listener());
    }
  };
});

const wallet = vi.hoisted(() => ({
  isReady: async () => true,
  isBooted: async () => true,
  hasVault: () => page.hasVault(),
  isUnlocked: async () => page.unlocked,
  unlock: async (_password: string) => undefined,
  resolveUnlockApproval: async () => false,
  setOpenInSidePanel: async () => undefined,
  getCurrentAccount: async () => ({ address: page.account }),
  getAccounts: async () => [{ address: 'qbit-test-address' }],
  getChainType: () => page.chainType(),
  getLocale: async () => 'en',
  getSkippedVersion: async () => '',
  getAutoLockTimeId: async () => 0,
  getDeveloperMode: async () => false,
  lockWallet: () => page.lockWallet(),
  getApproval: async () => page.approval,
  // As the background: only the pending request's id settles it.
  rejectApproval: async (id: string) => {
    page.rejected.push(id);
    const pending = page.approval?.id === id;
    if (pending) page.approval = undefined;
    return pending;
  },
  resolveApproval: async () => true
}));

vi.mock('@qbit/wallet-state', async () => {
  const React = await import('react');
  const subscribe = (listener: () => void) => {
    page.listeners.add(listener);
    return () => page.listeners.delete(listener);
  };
  const passThrough = <T,>(value: T) => value;
  const NavigationContext = React.createContext(null);
  const ApprovalContext = React.createContext(null);
  return {
    NavigationContext,
    ApprovalContext,
    useChain: () => ({ websiteUrl: 'https://example.org' }),
    BiometricCeremonyCancelledError: class extends Error {},
    BiometricRecordStaleError: class extends Error {},
    accountActions: { setCurrent: passThrough, setAccounts: passThrough },
    globalActions: { update: passThrough },
    settingsActions: { updateSettings: passThrough },
    useAppDispatch: () => () => undefined,
    useIsReady: () => true,
    useBooted: () => true,
    useIsUnlocked: () => React.useSyncExternalStore(subscribe, () => page.unlocked),
    useWallet: () => wallet,
    useResetUiTxCreateScreen: () => () => {
      page.formResets += 1;
    },
    useResetFeeRateBar: () => () => undefined,
    useApproval: () => React.useContext(ApprovalContext),
    // As the real hook: the store turns unlocked once the background has.
    useUnlockCallback: () => async (password: string) => {
      await wallet.unlock(password);
      page.setUnlocked(true);
      await wallet.resolveUnlockApproval().catch(() => false);
    },
    useBiometricUnlock: () => ({ ready: false, supported: false, enrolled: false, unlockWithBiometric: vi.fn() }),
    useNavigation: () => React.useContext(NavigationContext),
    useI18n: () => ({ t: (key: string) => key }),
    useTools: () => ({ toastError: vi.fn(), toastWarning: vi.fn() })
  };
});

// A wallet tab.
vi.mock('@/ui/web', () => ({
  getUiType: () => ({ isNotification: false, isPop: false, isSidePanel: false, isTab: true })
}));

vi.mock('@/ui/components', async () => {
  const React = await import('react');
  const Container = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children);
  return {
    Column: Container,
    Content: Container,
    Icon: Container,
    Row: Container,
    Tooltip: Container,
    Layout: (props: { children?: ReactNode }) => React.createElement(page.Layout, props)
  };
});
vi.mock('@/ui/components/Button', async () => {
  const React = await import('react');
  return {
    Button: ({ text, onClick, disabled, 'data-testid': testId }: Record<string, never>) =>
      React.createElement('button', { onClick, disabled, 'data-testid': testId }, text)
  };
});
vi.mock('@/ui/components/Input', async () => {
  const React = await import('react');
  return {
    Input: ({ onChange, onKeyUp, 'data-testid': testId }: Record<string, never>) =>
      React.createElement('input', { onChange, onKeyUp, 'data-testid': testId })
  };
});
vi.mock('@/ui/components/Logo', async () => {
  const React = await import('react');
  const { useLocation } = await import('react-router-dom');
  // Rendered by the unlock screen only.
  return {
    Logo: () => {
      page.unlockState = useLocation().state;
      React.useEffect(() => {
        page.shown.push('unlock');
      }, []);
      return null;
    }
  };
});
vi.mock('@/ui/components/Text', () => ({ Text: () => null }));
vi.mock('../components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('../web/tabs', () => ({ openExtensionInTab: vi.fn() }));
// What the start-up error screen's Retry would call; nothing here does.
vi.mock('@/background/webapi/browser', () => ({ browserRuntimeReload: vi.fn() }));

vi.mock('./Main/WalletTabScreen', async () => {
  const React = await import('react');
  const { useIsUnlocked, useNavigation } = await import('@qbit/wallet-state');
  return {
    default: function Home() {
      const isUnlocked = useIsUnlocked();
      const nav = useNavigation();
      React.useEffect(() => {
        page.shown.push('home');
      }, []);
      // WalletTabScreen's own redirect on a lock.
      React.useEffect(() => {
        if (!isUnlocked) {
          nav.navToLock({ autoUnlockByFace: false });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [isUnlocked]);
      return React.createElement(
        page.Layout,
        null,
        React.createElement('div', { 'data-testid': 'home' }),
        React.createElement(page.LockWalletButton)
      );
    }
  };
});
vi.mock('./Main/SettingsTabScreen', async () => {
  const React = await import('react');
  return {
    default: function Settings() {
      React.useEffect(() => {
        page.shown.push('settings');
      }, []);
      return React.createElement(
        page.Layout,
        null,
        React.createElement('div', { 'data-testid': 'settings' }),
        React.createElement(page.LockWalletButton)
      );
    }
  };
});
vi.mock('./Main/WelcomeScreen', async () => {
  const React = await import('react');
  return {
    default: function Welcome() {
      React.useEffect(() => {
        page.shown.push('welcome');
      }, []);
      return null;
    }
  };
});
vi.mock('./Account/AddKeyringScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateAccountScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateHDWalletScreen', () => ({ default: () => null }));
vi.mock('./Account/CreatePasswordScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateReadonlyWalletScreen', () => ({ default: () => null }));
vi.mock('./Account/CreateWatchWalletScreen', () => ({ default: () => null }));
vi.mock('./Approval/ApprovalScreen', () => ({ default: () => null }));
vi.mock('./Approval/ConnectedSitesScreen', () => ({ default: () => null }));
vi.mock('./Main/DiscoverTabScreen', () => ({ default: () => null }));
vi.mock('./Main/MineTabScreen', () => ({ default: () => null }));
vi.mock('./Phishing/PhishingScreen', () => ({ default: () => null }));
vi.mock('./Settings/AboutUsScreen', () => ({ default: () => null }));
vi.mock('./Settings/AddressTypeScreen', () => ({ default: () => null }));
vi.mock('./Settings/AdvancedScreen', () => ({ default: () => null }));
vi.mock('./Settings/AdvancedScreen/LockTimePage', () => ({ LockTimePage: () => null }));
vi.mock('./Settings/AdvancedScreen/RegtestAccessScreen', () => ({ RegtestAccessScreen: () => null }));
vi.mock('./Settings/ChangePasswordScreen', () => ({ default: () => null }));
vi.mock('./Settings/ContactsScreen', () => ({ default: () => null }));
vi.mock('./Settings/EditContactScreen', () => ({ default: () => null }));
vi.mock('./Settings/ExportMnemonicsScreen', () => ({ default: () => null }));
vi.mock('./Settings/ExportPrivateKeyScreen', () => ({ default: () => null }));
vi.mock('./Settings/AppearanceScreen', () => ({ default: () => null }));
vi.mock('./Settings/BiometricUnlockScreen', () => ({ default: () => null }));
vi.mock('./Settings/LanguageScreen', () => ({ default: () => null }));
vi.mock('./Settings/NetworkTypeScreen', () => ({ default: () => null }));
vi.mock('./Settings/UpgradeNoticeScreen', () => ({ default: () => null }));
vi.mock('./Test/TestScreen', () => ({ default: () => null }));
vi.mock('./Wallet/HistoryScreen', () => ({ default: () => null }));
vi.mock('./Wallet/QbitConsolidationScreen', () => ({ default: () => null }));
vi.mock('./Wallet/QbitRecoveryMigrationScreen', () => ({ default: () => null }));
vi.mock('./Wallet/ReceiveScreen', () => ({ default: () => null }));
vi.mock('./Wallet/TxConfirmScreen', async () => {
  const React = await import('react');
  return {
    default: function SendConfirm() {
      React.useEffect(() => {
        page.shown.push('confirm');
      }, []);
      return React.createElement(page.Layout, null, React.createElement('div', { 'data-testid': 'send-confirm' }));
    }
  };
});
vi.mock('./Wallet/TxCreateScreen', async () => {
  const React = await import('react');
  return {
    default: function SendForm() {
      React.useEffect(() => {
        page.shown.push('form');
      }, []);
      return React.createElement(page.Layout, null, React.createElement('div', { 'data-testid': 'send-form' }));
    }
  };
});
vi.mock('./Wallet/TxFailScreen', () => ({ default: () => null }));
vi.mock('./Wallet/TxSuccessScreen', () => ({ default: () => null }));

page.Layout = Layout;
page.LockWalletButton = LockWalletButton;

// The page's store, as far as Layout and the unlock screen read it: whether
// the wallet is unlocked, the account and network the page shows, and the
// store's record of the account and network the send form belongs to, which
// it renews only when it clears the form for another one.
const SEND_FORM_SCOPE = { address: 'qbit-test-address', chainType: 'QBIT_MAINNET' };
function storeState() {
  return {
    global: { isUnlocked: page.unlocked },
    accounts: { current: { address: 'qbit-test-address' } },
    settings: { chainType: 'QBIT_MAINNET' },
    ui: { sendFormScope: SEND_FORM_SCOPE }
  };
}
let state = storeState();
const store = {
  getState: () => {
    if (state.global.isUnlocked !== page.unlocked) state = storeState();
    return state;
  },
  subscribe: (listener: () => void) => {
    page.listeners.add(listener);
    return () => {
      page.listeners.delete(listener);
    };
  },
  dispatch: (action: unknown) => action
};

// The page the tab showed before the wallet opened in it. It matches no
// wallet route, so the router shows nothing there: Back from the wallet's
// first entry that lands here has left the wallet pages.
const ELSEWHERE = '/elsewhere.html';

let walletStart = 0;

/** A tab opened on `index.html` (or `path`), on top of another page. */
function openTab(path = '/index.html') {
  window.history.pushState(null, '', `${ELSEWHERE}#/elsewhere`);
  window.history.pushState(null, '', path);
  walletStart = window.history.length - 1;
  render(
    <Provider store={store as never}>
      <Main />
    </Provider>
  );
}

/** The wallet's entries in this tab: the tab's own entry and every one after it. */
const walletEntries = () => window.history.length - walletStart;

async function settle() {
  // Long enough for the start screen's reads, the router and any redirect a
  // screen makes as it is shown.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

async function expectRoute(route: string) {
  await waitFor(() => expect(window.location.hash).toBe(`#${route}`));
  await settle();
  expect(window.location.hash).toBe(`#${route}`);
}

async function back() {
  page.shown.length = 0;
  await act(async () => {
    // The step may land on an entry with the same address: wait for the step.
    const stepped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    window.history.back();
    await stepped;
  });
  await settle();
}

async function expectLeftTheWallet() {
  await waitFor(() => expect(window.location.pathname).toBe(ELSEWHERE));
  expect(page.shown).toEqual([]);
}

async function unlockHere() {
  fireEvent.change(await screen.findByTestId('unlock-password-input'), { target: { value: 'password' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('unlock-button'));
  });
}

/** A lock reaching the page: the store turns locked, as the background's broadcast makes it. */
async function lock() {
  await act(async () => {
    page.setUnlocked(false);
  });
}

/** Holds the background's answer to the next lockWallet; returns its release. */
function holdLockAnswer(): () => Promise<void> {
  let answer!: () => void;
  page.lockWallet = () =>
    new Promise<void>((resolve) => {
      answer = resolve;
    });
  return () =>
    act(async () => {
      answer();
    });
}

async function pressLockButton() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('lock-wallet-button'));
  });
}

/** Opens a screen by its address, as a link would. */
async function goTo(route: string) {
  await act(async () => {
    window.location.hash = `#${route}`;
  });
  await expectRoute(route);
}

async function forward() {
  page.shown.length = 0;
  await act(async () => {
    const stepped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    window.history.forward();
    await stepped;
  });
  await settle();
}

/** Another window unlocks the wallet: the store turns unlocked, as the background's broadcast makes it. */
async function unlockElsewhere() {
  await act(async () => {
    page.setUnlocked(true);
  });
}

/** Holds the background's answer to hasVault; returns its release with the answer. */
function holdHasVault(): (hasVault: boolean) => Promise<void> {
  let answer!: (hasVault: boolean) => void;
  const held = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  page.hasVault = () => held;
  return (hasVault) =>
    act(async () => {
      answer(hasVault);
    });
}

/** Holds the background's answer to getChainType; returns its release. */
function holdChainType(): () => Promise<void> {
  let answer!: (chainType: string) => void;
  const held = new Promise<string>((resolve) => {
    answer = resolve;
  });
  page.chainType = () => held;
  return () =>
    act(async () => {
      answer('QBIT_MAINNET');
    });
}

/** A tab on Home, the send form opened from it, then a lock while the form is shown: [Home, form, unlock]. */
async function lockOnSendForm() {
  page.unlocked = true;
  openTab();
  await expectRoute('/main');
  await goTo('/wallet/tx/create');
  expect(walletEntries()).toBe(2);
  // Layout's redirect from the form remembers it and adds the unlock entry.
  await lock();
  await expectRoute('/account/unlock');
  expect(walletEntries()).toBe(3);
  expect(getInterruptedSendForm()).toBeDefined();
  page.shown.length = 0;
}

describe('the history of a wallet tab around an unlock', () => {
  beforeEach(() => {
    page.unlocked = false;
    page.shown.length = 0;
    page.unlockState = undefined;
    page.lockWallet = async () => undefined;
    page.hasVault = async () => true;
    page.account = 'qbit-test-address';
    page.chainType = async () => 'QBIT_MAINNET';
    page.formResets = 0;
    page.approval = undefined;
    page.rejected = [];
    const warn = console.warn.bind(console);
    // The page before the wallet matches no route, by design.
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('No routes matched location "/elsewhere"')) warn(...args);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    forgetInterruptedSendForm();
  });

  it('keeps one entry, Home, after an unlock in a tab opened locked, and Back leaves the wallet', async () => {
    openTab();
    await expectRoute('/account/unlock');
    expect(walletEntries()).toBe(1);

    await unlockHere();
    await expectRoute('/main');
    expect(walletEntries()).toBe(1);
    expect(page.shown).toEqual(['unlock', 'home']);

    await back();
    await expectLeftTheWallet();
  });

  it('keeps one entry, Home, in a tab opened unlocked, and Back leaves the wallet', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    expect(walletEntries()).toBe(1);
    expect(page.shown).toEqual(['home']);

    await back();
    await expectLeftTheWallet();
  });

  it('keeps one entry, Home, when opening the wallet cancels a website request, and Back leaves the wallet', async () => {
    page.unlocked = true;
    page.approval = { id: 'connect-request', data: { approvalComponent: 'Connect' } };
    openTab();
    await expectRoute('/main');
    expect(page.rejected).toEqual(['connect-request']);
    expect(walletEntries()).toBe(1);

    await back();
    await expectLeftTheWallet();
  });

  it('gives the unlock screen up for Home when another window unlocks the wallet', async () => {
    openTab();
    await expectRoute('/account/unlock');

    await act(async () => {
      page.setUnlocked(true);
    });
    await expectRoute('/main');
    expect(walletEntries()).toBe(1);

    await back();
    await expectLeftTheWallet();
  });

  it('gives Home the place of an unlock screen a tab is restored on while unlocked', async () => {
    page.unlocked = true;
    openTab('/index.html#/account/unlock');
    await expectRoute('/main');
    expect(walletEntries()).toBe(1);

    await back();
    await expectLeftTheWallet();
  });

  it('puts Home in the unlock screen’s place after a lock on another screen: [Settings, unlock] becomes [Settings, Home]', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    await act(async () => {
      window.location.hash = '#/settings';
    });
    await expectRoute('/settings');
    expect(walletEntries()).toBe(2);

    // The lock: Layout sends the page to the unlock screen with a new entry.
    await lock();
    await expectRoute('/account/unlock');
    expect(walletEntries()).toBe(3);
    await unlockHere();
    await expectRoute('/main');
    expect(walletEntries()).toBe(3);

    await back();
    expect(window.location.hash).toBe('#/settings');
    expect(page.shown).toEqual(['settings']);
    await back();
    expect(window.location.hash).toBe('#/main');
    expect(page.shown).toEqual(['home']);
    await back();
    await expectLeftTheWallet();
  });

  it('puts the unlock screen in Home’s place for a lock that reaches Home, and the unlock puts Home back', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    expect(walletEntries()).toBe(1);

    // Another window, or the auto-lock: no lock button pressed here.
    await lock();
    await expectRoute('/account/unlock');
    expect(walletEntries()).toBe(1);
    expect(page.unlockState).toEqual({ autoUnlockByFace: false });
    await unlockHere();
    await expectRoute('/main');
    expect(walletEntries()).toBe(1);

    await back();
    await expectLeftTheWallet();
  });

  it('keeps one unlock entry for Home’s lock button, and the unlock puts Home back', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    const releaseLockAnswer = holdLockAnswer();

    await pressLockButton();
    // The broadcast of the lock reaches the page before the button's answer.
    await lock();
    await expectRoute('/account/unlock');
    await releaseLockAnswer();
    await expectRoute('/account/unlock');
    expect(walletEntries()).toBe(1);
    // No Touch ID prompt after a lock by hand.
    expect(page.unlockState).toEqual({ autoUnlockByFace: false });
    await unlockHere();
    await expectRoute('/main');
    expect(walletEntries()).toBe(1);

    await back();
    await expectLeftTheWallet();
  });

  it('adds one unlock entry for a lock button on another screen: [Settings, unlock] becomes [Settings, Home]', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    await goTo('/settings');
    expect(walletEntries()).toBe(2);
    const releaseLockAnswer = holdLockAnswer();

    await pressLockButton();
    await lock();
    await expectRoute('/account/unlock');
    await releaseLockAnswer();
    await expectRoute('/account/unlock');
    expect(walletEntries()).toBe(3);
    expect(page.unlockState).toEqual({ autoUnlockByFace: false });
    await unlockHere();
    await expectRoute('/main');
    expect(walletEntries()).toBe(3);

    await back();
    expect(window.location.hash).toBe('#/settings');
    expect(page.shown).toEqual(['settings']);
  });

  it('leaves the wallet when Back comes from the unlock screen of a lock on Home, the tab’s first entry', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    await lock();
    await expectRoute('/account/unlock');

    await back();
    await expectLeftTheWallet();
  });

  it('stays on the screen before Home when Back comes from the unlock screen of a lock on Home, without growing the history', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    await goTo('/settings');
    await goTo('/main');
    await lock();
    await expectRoute('/account/unlock');
    expect(walletEntries()).toBe(3);

    // Settings, still locked, sends the page to the unlock screen again.
    for (let step = 0; step < 3; step += 1) {
      await back();
      await expectRoute('/account/unlock');
      expect(page.shown).toEqual(['settings', 'unlock']);
      expect(walletEntries()).toBe(3);
    }

    await unlockHere();
    await expectRoute('/main');
    await back();
    expect(window.location.hash).toBe('#/settings');
  });

  it('stays on the screen locked when Back comes from its unlock screen, without growing the history', async () => {
    page.unlocked = true;
    openTab();
    await expectRoute('/main');
    await goTo('/settings');
    await lock();
    await expectRoute('/account/unlock');
    expect(walletEntries()).toBe(3);

    for (let step = 0; step < 3; step += 1) {
      await back();
      await expectRoute('/account/unlock');
      expect(page.shown).toEqual(['settings', 'unlock']);
      expect(walletEntries()).toBe(3);
    }
  });

  describe('with a send form a lock interrupted', () => {
    it.each([
      ['an unlock on this screen', unlockHere],
      ['an unlock in another window', unlockElsewhere]
    ])(
      'steps back to the form’s own entry after %s: Back gives Home, never the unlock screen, and Forward gives Home in its place',
      async (_label, unlockNow) => {
        await lockOnSendForm();

        await unlockNow();

        await expectRoute('/wallet/tx/create');
        expect(page.shown).toEqual(['form']);
        // The unlock entry is the one after the form's now.
        expect(walletEntries()).toBe(3);
        expect(getInterruptedSendForm()).toBeUndefined();
        expect(page.formResets).toBe(0);

        await back();
        expect(window.location.hash).toBe('#/main');
        expect(page.shown).toEqual(['home']);
        await forward();
        expect(window.location.hash).toBe('#/wallet/tx/create');
        expect(page.shown).toEqual(['form']);
        // The unlock screen of an unlocked wallet gives way to Home.
        await forward();
        await expectRoute('/main');
        expect(page.shown[page.shown.length - 1]).toBe('home');
        expect(walletEntries()).toBe(3);
        await back();
        expect(window.location.hash).toBe('#/wallet/tx/create');
        expect(page.shown).toEqual(['form']);
      }
    );

    it('steps back to the form after a lock that reached the unlock screen twice: one unlock entry', async () => {
      page.unlocked = true;
      openTab();
      await expectRoute('/main');
      // Home's lock button is pressed, and the form opened before the lock
      // lands: first the broadcast (Layout's redirect from the form), then
      // the button's answer (navToLock, from the unlock screen).
      const releaseLockAnswer = holdLockAnswer();
      await pressLockButton();
      await goTo('/wallet/tx/create');
      await lock();
      await expectRoute('/account/unlock');
      await releaseLockAnswer();
      await expectRoute('/account/unlock');
      expect(page.unlockState).toEqual({ autoUnlockByFace: false });
      expect(walletEntries()).toBe(3);
      page.shown.length = 0;

      await unlockHere();

      await expectRoute('/wallet/tx/create');
      expect(page.shown).toEqual(['form']);
      expect(walletEntries()).toBe(3);
      await back();
      expect(window.location.hash).toBe('#/main');
    });

    it('puts Home, with the form cleared, in the unlock screen’s place when the account changed: Back gives the form', async () => {
      await lockOnSendForm();
      // Another window switched the account meanwhile.
      page.account = 'qbit-other-address';

      await unlockHere();

      await expectRoute('/main');
      expect(page.shown).toEqual(['home']);
      expect(walletEntries()).toBe(3);
      expect(page.formResets).toBe(1);
      await back();
      expect(window.location.hash).toBe('#/wallet/tx/create');
      expect(page.shown).toEqual(['form']);
    });

    it('puts Home in the unlock screen’s place, once, when the step back to the form goes nowhere', async () => {
      await lockOnSendForm();
      // No earlier entry to go to.
      const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

      await unlockHere();
      await waitFor(() => expect(historyBack).toHaveBeenCalledOnce());
      historyBack.mockRestore();
      expect(window.location.hash).toBe('#/account/unlock');

      await waitFor(() => expect(window.location.hash).toBe('#/main'), {
        timeout: SEND_FORM_RETURN_FALLBACK_MS + 2000
      });
      await act(() => new Promise((resolve) => setTimeout(resolve, SEND_FORM_RETURN_FALLBACK_MS + 200)));
      expect(page.shown).toEqual(['home']);
      expect(walletEntries()).toBe(3);
      // The account and network matched: the form is kept.
      expect(page.formResets).toBe(0);
      await back();
      expect(window.location.hash).toBe('#/wallet/tx/create');
    }, 10_000);
  });

  describe('with the send confirm screen shown', () => {
    // Every screen each Back and Forward below showed.
    let seen: string[] = [];

    async function step(move: () => Promise<void>) {
      await move();
      seen = [...seen, ...page.shown];
    }

    /** A send reviewed on the confirm screen: [Home, form, confirm]. */
    async function openConfirmScreen() {
      page.unlocked = true;
      openTab();
      await expectRoute('/main');
      await goTo('/wallet/tx/create');
      await goTo('/wallet/tx/confirm');
      expect(walletEntries()).toBe(3);
      seen = [];
    }

    /** After the unlock: [Home, form, Home]. Back gives the form, never the confirm screen or the unlock screen. */
    async function expectTheConfirmScreenGone() {
      await expectRoute('/main');
      expect(page.shown).toEqual(['home']);
      expect(walletEntries()).toBe(3);
      // No send form was remembered: the unlock went Home.
      expect(page.formResets).toBe(0);

      await step(back);
      expect(window.location.hash).toBe('#/wallet/tx/create');
      expect(page.shown).toEqual(['form']);
      await step(back);
      expect(window.location.hash).toBe('#/main');
      await step(forward);
      expect(window.location.hash).toBe('#/wallet/tx/create');
      // Forward gives Home where the confirm screen was.
      await step(forward);
      expect(window.location.hash).toBe('#/main');
      expect(page.shown).toEqual(['home']);
      expect(walletEntries()).toBe(3);
      expect(seen).not.toContain('confirm');
      expect(seen).not.toContain('unlock');
    }

    it.each([
      ['an unlock on this screen', unlockHere],
      ['an unlock in another window', unlockElsewhere]
    ])(
      'puts the unlock screen, then Home, in its place after %s: Back gives the form',
      async (_label, unlockNow) => {
        await openConfirmScreen();

        // The lock reaches the page while the confirm screen shows, before
        // Sign or while its broadcast runs: Layout's redirect.
        await lock();
        await expectRoute('/account/unlock');
        expect(walletEntries()).toBe(3);
        // A lock there forgets any send form: the unlock goes Home.
        expect(getInterruptedSendForm()).toBeUndefined();
        page.shown.length = 0;

        await unlockNow();

        await expectTheConfirmScreenGone();
      }
    );

    it('keeps one entry in its place for a lock that reaches the unlock screen twice', async () => {
      page.unlocked = true;
      openTab();
      await expectRoute('/main');
      // Home's lock button is pressed, and the send reviewed before the lock
      // lands: first the broadcast (Layout's redirect from the confirm
      // screen), then the button's answer (navToLock, from the unlock screen).
      const releaseLockAnswer = holdLockAnswer();
      await pressLockButton();
      await goTo('/wallet/tx/create');
      await goTo('/wallet/tx/confirm');
      expect(walletEntries()).toBe(3);
      seen = [];
      await lock();
      await expectRoute('/account/unlock');
      await releaseLockAnswer();
      await expectRoute('/account/unlock');
      expect(walletEntries()).toBe(3);
      page.shown.length = 0;

      await unlockHere();

      await expectTheConfirmScreenGone();
    });
  });

  describe('for a wallet without a vault', () => {
    it('puts Welcome in the unlock screen’s place for an unlock in another window: one entry, and Back leaves the wallet', async () => {
      page.hasVault = async () => false;
      openTab();
      await expectRoute('/account/unlock');
      expect(walletEntries()).toBe(1);
      const answerHasVault = holdHasVault();
      page.shown.length = 0;

      await unlockElsewhere();
      // Home does not wait for the read.
      await expectRoute('/main');
      await answerHasVault(false);

      await expectRoute('/welcome');
      expect(page.shown).toEqual(['home', 'welcome']);
      expect(walletEntries()).toBe(1);
      // Neither the unlock screen nor Home is left in the history.
      await back();
      await expectLeftTheWallet();
    });

    it('puts Welcome in the place of the Home the send-form return put there when the account changed', async () => {
      await lockOnSendForm();
      page.account = 'qbit-other-address';
      const answerHasVault = holdHasVault();

      await unlockHere();
      await expectRoute('/main');
      expect(page.formResets).toBe(1);
      await answerHasVault(false);

      await expectRoute('/welcome');
      expect(page.shown).toEqual(['home', 'welcome']);
      expect(walletEntries()).toBe(3);
      await back();
      expect(window.location.hash).toBe('#/wallet/tx/create');
    });

    it('puts Welcome in the place of the Home the send-form return’s fallback put there', async () => {
      await lockOnSendForm();
      // No earlier entry to go to: the fallback goes Home.
      const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const answerHasVault = holdHasVault();

      await unlockHere();
      await waitFor(() => expect(historyBack).toHaveBeenCalledOnce());
      historyBack.mockRestore();
      await waitFor(() => expect(window.location.hash).toBe('#/main'), {
        timeout: SEND_FORM_RETURN_FALLBACK_MS + 2000
      });
      await answerHasVault(false);

      await expectRoute('/welcome');
      expect(page.shown).toEqual(['home', 'welcome']);
      expect(walletEntries()).toBe(3);
      await back();
      expect(window.location.hash).toBe('#/wallet/tx/create');
    }, 10_000);

    it('puts Welcome in the place of the Home the unlock put there: [Settings, unlock] becomes [Settings, Welcome]', async () => {
      page.unlocked = true;
      openTab();
      await expectRoute('/main');
      await goTo('/settings');
      await lock();
      await expectRoute('/account/unlock');
      expect(walletEntries()).toBe(3);
      const answerHasVault = holdHasVault();
      page.shown.length = 0;

      await unlockHere();
      // The store turned unlocked first: Home took the unlock screen's place.
      await expectRoute('/main');
      await answerHasVault(false);

      await expectRoute('/welcome');
      expect(page.shown).toEqual(['home', 'welcome']);
      expect(walletEntries()).toBe(3);
      await back();
      expect(window.location.hash).toBe('#/settings');
      expect(page.shown).toEqual(['settings']);
    });

    it('takes no other screen’s entry once the page has moved on from the Home the unlock put there', async () => {
      page.unlocked = true;
      openTab();
      await expectRoute('/main');
      await goTo('/settings');
      await lock();
      await expectRoute('/account/unlock');
      const answerHasVault = holdHasVault();

      await unlockHere();
      await expectRoute('/main');
      // The user opens Settings from Home before the answer lands.
      await goTo('/settings');
      expect(walletEntries()).toBe(4);
      page.shown.length = 0;
      await answerHasVault(false);
      await settle();

      expect(window.location.hash).toBe('#/settings');
      expect(page.shown).toEqual([]);
      expect(walletEntries()).toBe(4);
      await back();
      expect(window.location.hash).toBe('#/main');
    });

    it('ends on Welcome in the tab’s one entry after a lock on Home, and Back leaves the wallet', async () => {
      page.unlocked = true;
      openTab();
      await expectRoute('/main');
      await lock();
      await expectRoute('/account/unlock');
      const answerHasVault = holdHasVault();

      await unlockHere();
      await expectRoute('/main');
      await answerHasVault(false);

      await expectRoute('/welcome');
      expect(walletEntries()).toBe(1);
      await back();
      await expectLeftTheWallet();
    });

    it('puts Welcome in the unlock screen’s place after the step back to a send form: Back gives the form', async () => {
      await lockOnSendForm();
      const answerHasVault = holdHasVault();

      await unlockHere();
      await expectRoute('/wallet/tx/create');
      await answerHasVault(false);

      await expectRoute('/welcome');
      expect(page.shown).toEqual(['form', 'welcome']);
      expect(walletEntries()).toBe(3);
      await back();
      expect(window.location.hash).toBe('#/wallet/tx/create');
      expect(page.shown).toEqual(['form']);
    });

    it('puts Welcome in the unlock screen’s place, and takes no step back, when a send form is remembered', async () => {
      await lockOnSendForm();
      page.hasVault = async () => false;
      // The account and network are still being read when the unlock ends.
      const answerChainType = holdChainType();

      await unlockHere();
      await expectRoute('/welcome');
      expect(getInterruptedSendForm()).toBeUndefined();
      await answerChainType();
      await settle();

      expect(window.location.hash).toBe('#/welcome');
      expect(page.shown).toEqual(['welcome']);
      expect(walletEntries()).toBe(3);
      await back();
      expect(window.location.hash).toBe('#/wallet/tx/create');
    });
  });
});
