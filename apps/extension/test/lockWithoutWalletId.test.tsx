/**
 * A page that loaded before the wallet existed and has not recorded the id of
 * the wallet set up since, its id read still failing, at a lock. It knows of
 * no vault, so neither does Layout, which sends a locked page to the unlock
 * screen only once its store knows of one; and a page that shows no wallet
 * content sends its calls unjudged (createWalletProxy). So it keeps what it
 * shows, and goes on refusing, until it knows of a vault: then, in one step,
 * it drops what it showed and Layout takes it to the unlock screen (#198). A
 * page that has recorded the id goes there at once
 * (lockAfterFirstWallet.test.tsx).
 *
 * First, the page's real store, updater, router (MainRoute, with its routes
 * and its read of the vault as the page loads), Layout and screens, with the
 * background behind the wallet controller stood in for. There the calls go to
 * it directly: those screens and the updater make reads that the wallet-id
 * rule refuses on such a page, and do not all catch the refusal, which the
 * test run would report as an error. The reads the race below turns on are
 * ones the rule sends without an id. Then the same page through the rule as
 * the UI entry wires it, with the real Layout and stand-in screens.
 */
import { useEffect, useState } from 'react';
import { Provider, useStore } from 'react-redux';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PAGE_WALLET_ID_RETRY_DELAYS_MS, PageStartup } from '@/ui/components/PageStartup';
import { Layout } from '@/ui/components/Layout';
import Main from '@/ui/pages/MainRoute';
import {
  forgetShownWalletId,
  getShownWalletId,
  installPageWalletResetHandler,
  pageShowsWalletContent,
  refuseWithoutWalletId
} from '@/ui/utils/walletReset';
import { sendUnderWalletIdRule } from '@/ui/web/ui-messaging';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { BUS_METHODS, KeyringType } from '@qbit/wallet-shared';
import {
  AccountUpdater,
  type AppState,
  createAppStore,
  globalActions,
  uiEventBus,
  useWallet,
  WalletProvider
} from '@qbit/wallet-state';
import { AddressType, ChainType } from '@qbit/wallet-types';

// The extension's test config takes @qbit/wallet-state from its sources, whose
// own `src/...` imports only that package's config resolves. The page's real
// store, hooks and updater come from the package's build instead, which the
// checks build before they test.
vi.mock('@qbit/wallet-state', () => import('../../../packages/wallet-state/lib/index.mjs'));
// The home screen, which only an unlock below goes to, as a stand-in: its own
// reads of the browser's tabs take no part here.
vi.mock('@/ui/pages/Main/WalletTabScreen', () => ({ default: () => <span data-testid="home-screen" /> }));

// The extension APIs some screens reach for as they load; none of them takes
// part here: every property is another such stand-in, every call does nothing.
vi.hoisted(() => {
  const extensionApi = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => (key === 'then' ? undefined : extensionApi()),
      apply: () => undefined
    });
  (globalThis as { chrome?: unknown }).chrome = extensionApi();
});

const ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw';
const ACCOUNT = {
  type: KeyringType.QbitHdKeyring,
  address: ADDRESS,
  brandName: 'Qbit',
  alianName: 'Account 1',
  displayBrandName: 'Qbit',
  index: 0,
  balance: 0,
  pubkey: 'pubkey-1',
  key: 'keyring_0#0',
  flag: 0
};
const KEYRING = {
  key: 'keyring_0',
  index: 0,
  type: KeyringType.QbitHdKeyring,
  addressType: AddressType.P2MR,
  accounts: [ACCOUNT],
  alianName: 'Wallet 1',
  color: 'green',
  hdPath: String.raw`m/87'/0'/0'/0`
};
const FEE_SUMMARY = {
  list: [
    { title: 'slow', desc: 'slow', feeRate: 1 },
    { title: 'avg', desc: 'avg', feeRate: 2 },
    { title: 'fast', desc: 'fast', feeRate: 3 }
  ]
};
// As when the first save of the new wallet's id fails, and keeps failing.
const ID_SAVE_FAILED = { message: 'QUOTA_BYTES quota exceeded' };

// The background, as the page's wallet controller reaches it. The wallet's
// password exists, so it is unlocked; the vault exists once a wallet is saved.
// A locked wallet names no account.
function createBackground() {
  const state = {
    vault: false,
    unlocked: true,
    holdVaultReads: false,
    // Told of every call the page makes, by its method, when set.
    onCall: undefined as ((method: string) => void) | undefined
  };
  // Vault reads made while `holdVaultReads` is set, answered when the test says.
  const heldVaultReads: Array<() => void> = [];
  const named = () => state.vault && state.unlocked;
  const wallet = {
    hasVault: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          if (state.holdVaultReads) {
            heldVaultReads.push(() => resolve(state.vault));
          } else {
            resolve(state.vault);
          }
        })
    ),
    isBooted: vi.fn(async () => state.vault),
    // None before a wallet is saved; then it cannot be read.
    getWalletId: vi.fn(async (): Promise<string | null> => {
      if (state.vault) throw ID_SAVE_FAILED;
      return null;
    }),
    isUnlocked: vi.fn(async () => state.unlocked),
    getCurrentAccount: vi.fn(async () => (named() ? ACCOUNT : null)),
    getAccounts: vi.fn(async () => (named() ? [ACCOUNT] : [])),
    getKeyrings: vi.fn(async () => (named() ? [KEYRING] : [])),
    getCurrentKeyring: vi.fn(async () => (named() ? KEYRING : null)),
    getChainType: vi.fn(async () => ChainType.QBIT_MAINNET),
    getLocale: vi.fn(async () => 'en'),
    getSkippedVersion: vi.fn(async () => ''),
    getAutoLockTimeId: vi.fn(async () => 0),
    getDeveloperMode: vi.fn(async () => false),
    getWalletConfig: vi.fn(async () => ({})),
    getBiometricUnlockStatus: vi.fn(async () => ({ enrolled: false })),
    getApproval: vi.fn(async () => undefined),
    getEnableRBF: vi.fn(async () => true),
    getFeeSummary: vi.fn(async () => FEE_SUMMARY),
    getLowFeeSummary: vi.fn(async () => FEE_SUMMARY),
    // Writes of the wallet's data, as the address book makes them.
    addContact: vi.fn(async () => true),
    setAccountAlianName: vi.fn(async () => ACCOUNT)
  };
  // Any other call stays unanswered, as on a slow background: the screens
  // wait for it, and are still shown.
  const background = new Proxy(wallet, {
    get: (target, key) => {
      if (typeof key === 'string' && key !== 'then') state.onCall?.(key);
      return key in target
        ? target[key as keyof typeof target]
        : key === 'then'
        ? undefined
        : () => new Promise(() => undefined);
    }
  });
  const answerHeldVaultReads = async () => {
    await act(async () => {
      heldVaultReads.splice(0).forEach((answer) => answer());
    });
  };
  return { state, wallet, background, answerHeldVaultReads };
}

let background: ReturnType<typeof createBackground>;
let store: ReturnType<typeof createAppStore>;

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actEnvironment: boolean | undefined;

beforeEach(() => {
  // The background's answers land when they land, as they do in the page:
  // React is not told to expect every update inside act().
  actEnvironment = (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = false;
  background = createBackground();
});

afterEach(() => {
  background.state.onCall = undefined;
  cleanup();
  forgetShownWalletId();
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
});

// The page loads at `route`.
async function loadPageAt(route: string) {
  window.history.replaceState(null, '', `/index.html#${route}`);
  store = createAppStore();
  render(
    <Provider store={store}>
      <WalletProvider wallet={background.background as never}>
        <AccountUpdater />
        <Main />
      </WalletProvider>
    </Provider>
  );
  // Its read of the vault as it loads has answered.
  await waitFor(() => expect(background.wallet.hasVault).toHaveBeenCalledTimes(1));
  await act(async () => undefined);
}

async function goTo(route: string, shownTestId: string) {
  await act(async () => {
    window.location.hash = `#${route}`;
  });
  await screen.findByTestId(shownTestId);
}

// The background tells every page what it does.
async function announce(method: string) {
  await act(async () => {
    uiEventBus.emit(method);
  });
}

async function lock() {
  background.state.unlocked = false;
  await announce(BUS_METHODS.LOCKED);
}

// Lets answers already given be acted on.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The page loaded on Welcome; a wallet is saved and announced unlocked; the
// page shows it without its id, on the send form; the wallet locks, and the
// reads of the vault are held: the lock's (AccountUpdater) and the one the
// run the lock starts makes, the page showing a wallet whose vault it does
// not know of while the background names no account.
async function lockedWithoutTheId() {
  await loadPageAt('/welcome');
  await screen.findByTestId('welcome-title');
  background.state.vault = true;
  await announce(BUS_METHODS.UNLOCKED);
  await waitFor(() => expect(store.getState().accounts.current.address).toBe(ADDRESS));
  await goTo('/wallet/tx/create', 'recipient-address-input');
  expect(getShownWalletId()).toBeUndefined();
  expect(store.getState().global.isBooted).toBe(false);

  background.state.holdVaultReads = true;
  await lock();
  await waitFor(() => expect(background.wallet.hasVault).toHaveBeenCalledTimes(3));
  await flush();
  // Until then it keeps what it showed, and stays.
  expect(window.location.hash).toBe('#/wallet/tx/create');
  expect(store.getState().accounts.current.address).toBe(ADDRESS);
}

describe('a page that loaded before the wallet existed and could not read its id since', () => {
  it('stays where it is, dropping nothing, when an unlock comes before the vault reads answer', async () => {
    await lockedWithoutTheId();

    background.state.unlocked = true;
    await announce(BUS_METHODS.UNLOCKED);
    await background.answerHeldVaultReads();
    await flush();

    expect(background.wallet.hasVault).toHaveBeenCalledTimes(3);
    expect(window.location.hash).toBe('#/wallet/tx/create');
    expect(screen.getByTestId('recipient-address-input')).toBeTruthy();
    expect(store.getState().accounts.current.address).toBe(ADDRESS);
    expect(getShownWalletId()).toBeUndefined();
  });

  it('goes to the unlock screen, showing nothing, once the vault reads answer with the wallet still locked', async () => {
    await lockedWithoutTheId();

    await background.answerHeldVaultReads();

    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
    expect(store.getState().global).toMatchObject({ isBooted: true, isUnlocked: false });
    expect(pageShowsWalletContent(store.getState())).toBe(false);
    expect(getShownWalletId()).toBeUndefined();
  });

  // The one commit the drop leaves (PageStartup, turnLocked): until Layout's
  // effect has left for the unlock screen, the screens that were mounted
  // render the emptied store, and the calls their effects make go out
  // without an id, as from any page that shows no wallet content. The send
  // screen's, as measured: none writes a wallet's data. A write added to its
  // effects would show here.
  it('sends, between the drop and the unlock screen, only the calls the send screen makes from its effects, none a write', async () => {
    await lockedWithoutTheId();
    const sentInTheWindow: string[] = [];
    background.state.onCall = (method) => {
      if (screen.queryByTestId('unlock-password-input') !== null) return;
      if (!pageShowsWalletContent(store.getState())) sentInTheWindow.push(method);
    };

    await background.answerHeldVaultReads();
    await screen.findByTestId('unlock-password-input');

    const SENT_AS_THE_EMPTIED_SEND_SCREEN_RENDERS = [
      'abandonQbitUtxoSnapshot',
      'getQbitSendPlan',
      'getQbitUtxoSnapshot',
      'getApproval'
    ];
    expect(sentInTheWindow.filter((method) => !SENT_AS_THE_EMPTIED_SEND_SCREEN_RENDERS.includes(method))).toEqual([]);
  });
});

// What a screen of the wallet does with what the page showed as it mounted,
// as the address book or the send form do: it keeps it in its own state,
// and its submit writes with it. Set while the screen is mounted.
let submitFromScreen: (() => Promise<PromiseSettledResult<unknown>[]>) | undefined;
function WalletScreen() {
  const wallet = useWallet() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const page = useStore<AppState>();
  const [builtFor] = useState(() => page.getState().accounts.current);
  useEffect(() => {
    submitFromScreen = () =>
      Promise.allSettled([
        wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }),
        wallet.setAccountAlianName(builtFor, 'Rent')
      ]);
    return () => {
      submitFromScreen = undefined;
    };
  }, [wallet, builtFor]);
  return <span data-testid="wallet-screen" />;
}

describe('a page without its id, through the wallet-id rule, on stand-in screens', () => {
  type Reached = { method: string; walletId: string | undefined };
  let reached: Reached[];
  let refusals: unknown[];
  const reloadOnBoot = vi.fn();
  let uninstallResetHandler: (() => void) | undefined;

  beforeEach(() => {
    reached = [];
    refusals = [];
    reloadOnBoot.mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    uninstallResetHandler?.();
    uninstallResetHandler = undefined;
    submitFromScreen = undefined;
    sessionStorage.clear();
  });

  // The page loads at `route`: PageStartup, the real Layout on each route,
  // and its calls sent through the wallet-id rule, as the UI entry wires
  // them (createWalletProxy), each one that reaches the background recorded.
  async function loadThroughTheRuleAt(route: string) {
    window.history.replaceState(null, '', `/index.html#${route}`);
    store = createAppStore();
    const page = store;
    uninstallResetHandler = installPageWalletResetHandler(page, { reload: vi.fn(), reloadOnBoot });
    const rule = {
      walletId: getShownWalletId,
      showsWalletContent: () => pageShowsWalletContent(page.getState()),
      refuseWithoutWalletId: () => {
        const refusal = refuseWithoutWalletId('wallet_page_id_unreadable');
        refusals.push(refusal);
        return refusal;
      }
    };
    const guarded = new Proxy(background.background, {
      get: (target, key) => {
        const member = (target as Record<string | symbol, unknown>)[key];
        if (typeof key !== 'string' || typeof member !== 'function') return member;
        return (...args: unknown[]) =>
          sendUnderWalletIdRule(key, rule, (walletId) => {
            reached.push({ method: key, walletId });
            return (member as (...callArgs: unknown[]) => Promise<unknown>)(...args);
          });
      }
    });
    render(
      <Provider store={page}>
        <WalletProvider wallet={guarded as never}>
          <PageStartup>
            <HashRouter>
              <Routes>
                <Route
                  path="/welcome"
                  element={
                    <Layout>
                      <span data-testid="welcome-screen" />
                    </Layout>
                  }
                />
                <Route
                  path="/settings/contacts"
                  element={
                    <Layout>
                      <WalletScreen />
                    </Layout>
                  }
                />
                <Route
                  path="/account/unlock"
                  element={
                    <Layout>
                      <span data-testid="unlock-screen" />
                    </Layout>
                  }
                />
              </Routes>
            </HashRouter>
          </PageStartup>
        </WalletProvider>
      </Provider>
    );
    await waitFor(() => expect(page.getState().global.isReady).toBe(true));
  }

  const writesReached = () =>
    reached.filter((call) => call.method === 'addContact' || call.method === 'setAccountAlianName');

  // Loaded on Welcome with nothing set up; another window makes a wallet,
  // whose id cannot be saved, and the background announces it unlocked; the
  // page shows it without its id, on a screen made from it.
  async function showingAWalletMadeElsewhere() {
    await loadThroughTheRuleAt('/welcome');
    await screen.findByTestId('welcome-screen');
    background.state.vault = true;
    // The background's UNLOCKED, as AccountUpdater takes it.
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }));
    });
    await waitFor(() => expect(store.getState().accounts.current.address).toBe(ADDRESS));
    await goTo('/settings/contacts', 'wallet-screen');
    expect(getShownWalletId()).toBeUndefined();
    expect(store.getState().global).toMatchObject({ isBooted: false, isUnlocked: true });
    // What the screen writes is refused.
    const writes = await submitFromScreen?.();
    expect(writes?.map((write) => write.status)).toEqual(['rejected', 'rejected']);
  }

  it('drops what it showed only as it goes to the unlock screen, when a retry of the id reads that the wallet locked unseen: the screen made from it never writes', async () => {
    await showingAWalletMadeElsewhere();

    // The wallet locks; this page does not hear of it, its connection down.
    // The retry of the id read after the first pause reads no account.
    const accountReads = background.wallet.getCurrentAccount.mock.calls.length;
    background.state.unlocked = false;
    await waitFor(() => expect(background.wallet.getCurrentAccount.mock.calls.length).toBeGreaterThan(accountReads), {
      timeout: PAGE_WALLET_ID_RETRY_DELAYS_MS[0] + 3_000
    });
    await flush();
    // From then on the screen made from what the page showed refuses, or is gone.
    if (submitFromScreen) {
      const writes = await submitFromScreen();
      expect(writes.map((write) => write.status)).toEqual(['rejected', 'rejected']);
    }
    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-screen');

    expect(screen.queryByTestId('wallet-screen')).toBeNull();
    expect(submitFromScreen).toBeUndefined();
    expect(store.getState().global).toMatchObject({ isBooted: true, isUnlocked: false });
    expect(pageShowsWalletContent(store.getState())).toBe(false);
    expect(writesReached()).toEqual([]);
    expect(background.wallet.addContact).not.toHaveBeenCalled();
    expect(background.wallet.setAccountAlianName).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('keeps what it showed, refusing, while the run cannot tell a vault is there; then an unlock comes first', async () => {
    await showingAWalletMadeElsewhere();
    background.state.holdVaultReads = true;

    background.state.unlocked = false;
    await waitFor(() => expect(background.wallet.hasVault).toHaveBeenCalledTimes(2), {
      timeout: PAGE_WALLET_ID_RETRY_DELAYS_MS[0] + 3_000
    });
    await flush();
    // The run waits for its vault read: the screen stays, and still refuses.
    expect(window.location.hash).toBe('#/settings/contacts');
    expect(pageShowsWalletContent(store.getState())).toBe(true);
    const meanwhile = await submitFromScreen?.();
    expect(meanwhile?.map((write) => write.status)).toEqual(['rejected', 'rejected']);

    // The wallet is unlocked again, in another window, before the read answers.
    background.state.unlocked = true;
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: false }));
    });
    await flush();
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }));
    });
    await background.answerHeldVaultReads();
    await flush();

    expect(window.location.hash).toBe('#/settings/contacts');
    expect(store.getState().accounts.current.address).toBe(ADDRESS);
    const after = await submitFromScreen?.();
    expect(after?.map((write) => write.status)).toEqual(['rejected', 'rejected']);
    expect(writesReached()).toEqual([]);
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });
});
