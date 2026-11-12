import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUS_METHODS, MESSAGE_TYPE, THEME_MODE_STORAGE_KEY } from '@qbit/wallet-shared';
import {
  AccountUpdater,
  accountActions,
  createAppStore,
  globalActions,
  keyringsActions,
  settingsActions,
  transactionsActions,
  uiActions,
  uiEventBus,
  WalletProvider
} from '@qbit/wallet-state';

// The real store, reducers, persistence and event bus, from the package build
// (run `pnpm build` first): the window's state as it is, not a stand-in.
vi.mock('@qbit/wallet-state', () => import('../../../packages/wallet-state/lib/index.mjs'));
// The Layout reads only the unlock route from the route table, which would
// otherwise load every screen.
vi.mock('@/ui/pages/MainRoute', () => ({
  routes: {
    MainScreen: { path: '/main' },
    UnlockScreen: { path: '/account/unlock' },
    TxCreateScreen: { path: '/wallet/tx/create' },
    TxConfirmScreen: { path: '/wallet/tx/confirm' }
  }
}));
// The window's port to the background: a fake one, answered by the test.
const ports = vi.hoisted(() => [] as unknown[]);
vi.mock('@/background/webapi/browser', () => ({
  browserRuntimeConnect: () => {
    const port = new TestPort();
    ports.push(port);
    return port;
  }
}));

import { Layout } from '../src/ui/components/Layout';
import {
  createReconnectReconcile,
  createUnlockGate,
  forgetShownWalletId,
  getShownWalletId,
  installPageWalletResetHandler,
  isShownWalletGoneError,
  pageShowsWalletContent,
  recordShownWalletId,
  reloadOnBootRoute,
  reloadOnWelcome,
  UNLOCK_REOPEN_WAIT_MS,
  WALLET_DATA_OWNER_KEY,
  WALLET_DATA_RESET_MARK
} from '../src/ui/utils/walletReset';
import {
  createPortMessageChannel,
  createWalletProxy,
  setupEventBusListeners,
  watchPortReconnects
} from '../src/ui/web/ui-messaging';

// Where the store saves its display preferences, and nothing of the send form.
const SAVED_UI_KEY = 'redux_localstorage_simple_ui';
// Nothing of the send form, anywhere in localStorage.
const noDraftSaved = () => expect(Object.values({ ...localStorage }).join('\n')).not.toContain(DRAFT_ADDRESS);
const DRAFT_ADDRESS = 'qb1zdraftrecipientaddress';

const account = {
  address: 'qb1zerasedaccount',
  alianName: 'Account 1',
  flag: 0,
  index: 0,
  key: 'keyring_0#0',
  pubkey: '02erased',
  type: 'Qbit HD Key Tree'
};
const keyring = {
  accountIndexDerivation: false,
  accounts: [account],
  addressType: 9,
  alianName: 'Savings',
  color: 'pink',
  hdPath: "m/87'/0'/0'/0",
  index: 0,
  key: 'keyring_0',
  type: 'Qbit HD Key Tree'
};

/**
 * A window with a wallet, a send draft (in its memory: no send form is saved),
 * balances hidden and the notice flags, sitting on the unlock screen.
 */
function windowOnTheUnlockScreen() {
  const store = createAppStore();
  store.dispatch(globalActions.update({ isReady: true, isBooted: true, isUnlocked: false }));
  store.dispatch(accountActions.setCurrent(account));
  store.dispatch(accountActions.setAccounts([account]));
  store.dispatch(keyringsActions.setKeyrings([keyring]));
  store.dispatch(keyringsActions.setCurrent(keyring));
  store.dispatch(transactionsActions.setSpendUnavailableUtxos([{ txid: 'aa', vout: 0 }]));
  store.dispatch(
    uiActions.updateTxCreateScreen({ toInfo: { address: DRAFT_ADDRESS }, inputAmount: '1.5', memo: 'rent' })
  );
  store.dispatch(uiActions.updateAddressInput({ address: DRAFT_ADDRESS }));
  store.dispatch(uiActions.setBalanceHidden(true));
  store.dispatch(
    settingsActions.updateSettings({ locale: 'ja', themeMode: 'dark', autoLockTimeId: 5, developerMode: true })
  );
  localStorage.setItem('ecosystem_warning_acknowledged', 'true');
  localStorage.setItem('mine_tab_seen', 'true');
  localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.9', isShow: false }));
  localStorage.setItem('i18nextLng', 'ja');
  localStorage.setItem('userSelectedLanguage', 'true');
  localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark');
  window.history.replaceState(null, '', '#/account/unlock');
  return store;
}

const storageKeys = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).sort();

describe('a window learning of a reset', () => {
  let uninstall: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('a second window learns of the reset and lands on Welcome', () => {
    // The first-run state a fresh store starts in, against empty storage. Read
    // first: every store shares the one pending save of the `ui` slice.
    const firstRun = createAppStore().getState();
    const store = windowOnTheUnlockScreen();
    // A second later the window has saved its display preferences, and
    // nothing of the send form, which is scoped to the account it was for.
    vi.advanceTimersByTime(1_100);
    expect(JSON.parse(localStorage.getItem(SAVED_UI_KEY) ?? 'null')).toEqual({
      isBalanceHidden: true,
      balanceDetailExpanded: true
    });
    noDraftSaved();
    expect(store.getState().ui.sendFormScope).toMatchObject({ address: account.address });
    const reload = vi.fn();
    uninstall = installPageWalletResetHandler(store, { reload: () => reloadOnWelcome(reload) });

    act(() => {
      uiEventBus.emit(BUS_METHODS.WALLET_RESET);
    });

    // Only the language and the theme are left in localStorage, and the owner
    // key, marked as reset.
    expect(storageKeys()).toEqual(
      ['i18nextLng', THEME_MODE_STORAGE_KEY, 'userSelectedLanguage', WALLET_DATA_OWNER_KEY].sort()
    );
    expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe(WALLET_DATA_RESET_MARK);
    expect(localStorage.getItem('i18nextLng')).toBe('ja');
    expect(localStorage.getItem('userSelectedLanguage')).toBe('true');
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('dark');
    // A save still due writes back only the initial preferences.
    vi.advanceTimersByTime(2_000);
    expect(JSON.parse(localStorage.getItem(SAVED_UI_KEY) ?? 'null')).toEqual({
      isBalanceHidden: false,
      balanceDetailExpanded: true
    });
    noDraftSaved();

    const state = store.getState();
    expect(state.global.isBooted).toBe(false);
    expect(state.global.isUnlocked).toBe(false);
    expect(state.global.isReady).toBe(true);
    expect(state.accounts).toEqual(firstRun.accounts);
    expect(state.keyrings).toEqual(firstRun.keyrings);
    expect(state.transactions).toEqual(firstRun.transactions);
    expect(state.ui).toEqual(firstRun.ui);
    // Preferences return to their defaults, except the language and the theme.
    expect(state.settings).toEqual({ ...firstRun.settings, locale: 'ja', themeMode: 'dark' });

    // It reopens on Welcome, from the unlock screen it was on.
    expect(window.location.hash).toBe('#/welcome');
    expect(reload).toHaveBeenCalledTimes(1);

    // The reopened page starts from what is left: no draft, not booted, and
    // the Layout keeps it on Welcome rather than the unlock screen.
    const reopened = createAppStore();
    expect(reopened.getState().ui.uiTxCreateScreen.toInfo.address).toBe('');
    render(
      <Provider store={reopened}>
        <Layout>
          <span data-testid="welcome-screen" />
        </Layout>
      </Provider>
    );
    expect(screen.getByTestId('welcome-screen')).toBeTruthy();
    expect(window.location.hash).toBe('#/welcome');
  });

  it('changes nothing further on a second WALLET_RESET', () => {
    const store = windowOnTheUnlockScreen();
    const reload = vi.fn();
    uninstall = installPageWalletResetHandler(store, { reload: () => reloadOnWelcome(reload) });
    act(() => {
      uiEventBus.emit(BUS_METHODS.WALLET_RESET);
    });
    const after = store.getState();
    localStorage.setItem('written_since', '1');

    act(() => {
      uiEventBus.emit(BUS_METHODS.WALLET_RESET);
    });

    expect(store.getState()).toBe(after);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('written_since')).toBe('1');
  });

  // The control: without the handler, the window keeps its flags and the
  // Layout sends it to the unlock screen of a wallet that no longer exists.
  it('without the handler, the stale flags keep the window on the unlock screen', () => {
    const store = windowOnTheUnlockScreen();
    window.history.replaceState(null, '', '#/welcome');

    act(() => {
      uiEventBus.emit(BUS_METHODS.WALLET_RESET);
    });
    render(
      <Provider store={store}>
        <Layout>
          <span data-testid="welcome-screen" />
        </Layout>
      </Provider>
    );

    expect(window.location.hash).toBe('#/account/unlock');
  });
});

type Envelope = { _type_: string; data: { ident?: number; data?: { method?: string } } };

// A port to the background as the window sees it: what it carried, and the
// background answering, broadcasting or going away.
class TestPort {
  posted: Envelope[] = [];
  disconnect = vi.fn();
  private answered = new Set<number | undefined>();
  private broadcasts = 0;
  private messageListeners: Array<(message: Envelope) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (listener: (message: Envelope) => void) => this.messageListeners.push(listener) };
  onDisconnect = { addListener: (listener: () => void) => this.disconnectListeners.push(listener) };

  postMessage(message: Envelope) {
    this.posted.push(message);
  }

  methods(): string[] {
    return this.posted
      .filter(({ _type_ }) => _type_ === `QBIT_WALLET_${MESSAGE_TYPE.REQUEST}`)
      .map(({ data }) => data.data?.method ?? '');
  }

  /** The background answers the oldest request for `method` it has not answered. */
  respond(method: string, answer: { res?: unknown; err?: unknown }) {
    const request = this.posted.find(({ data }) => data?.data?.method === method && !this.answered.has(data.ident));
    if (!request) throw new Error(`no unanswered ${method} request on this port`);
    this.answered.add(request.data.ident);
    const message = { _type_: `QBIT_WALLET_${MESSAGE_TYPE.RESPONSE}`, data: { ident: request.data.ident, ...answer } };
    this.messageListeners.forEach((listener) => listener(message));
  }

  /** The background broadcasts to the pages, as broadcastToUI does. */
  broadcast(method: string) {
    this.broadcasts += 1;
    const message = {
      _type_: `QBIT_WALLET_${MESSAGE_TYPE.REQUEST}`,
      data: { ident: 10_000 + this.broadcasts, data: { type: MESSAGE_TYPE.BG_BROADCAST, method, params: {} } }
    } as unknown as Envelope;
    this.messageListeners.forEach((listener) => listener(message));
  }

  /** The background went away: its service worker stopped or crashed. */
  drop() {
    this.disconnectListeners.forEach((listener) => listener());
  }
}

const port = (index: number) => ports[index] as TestPort;
const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

// A window wired as the UI entry wires every window: the WALLET_RESET handler
// on its store, the background's broadcasts fed to its event bus, its account
// updater (which records the background's UNLOCKED), and the checks of its
// wallet's id after a reconnection and at each unlock. `startup` is how the
// background's start-up goes for the reconnection check.
function windowWithItsChecks(
  store: ReturnType<typeof createAppStore>,
  startup: () => Promise<boolean> = async () => true,
  { accountUpdater = true } = {}
) {
  // localStorage as it stood when the page asked to reopen: the test keeps
  // the page alive past that, the browser would not.
  const storageAtReopen: Record<string, string>[] = [];
  const reloadOnBoot = vi.fn(() => {
    storageAtReopen.push({ ...localStorage });
  });
  const reload = vi.fn();
  const uninstallHandler = installPageWalletResetHandler(store, {
    reload: () => reloadOnWelcome(reload),
    reloadOnBoot: () => reloadOnBootRoute(reloadOnBoot)
  });
  const channel = createPortMessageChannel();
  let gate: ReturnType<typeof createUnlockGate> | undefined = undefined;
  const wallet = createWalletProxy(channel, { afterUnlock: async () => gate?.afterUnlock() });
  setupEventBusListeners(channel, { beforeUnlocked: async () => gate?.beforeUnlockedBroadcast() ?? true });
  const holdsWallet = () => {
    const { global, keyrings } = store.getState();
    return global.isBooted || keyrings.keyrings.length > 0;
  };
  // As the UI entry has it.
  const showsWalletContent = () => pageShowsWalletContent(store.getState());
  const reads = { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() };
  const checkAfterReconnect = createReconnectReconcile({
    holdsWallet,
    shownWalletId: getShownWalletId,
    showsWalletContent,
    wallet: reads,
    waitForStartup: startup
  });
  watchPortReconnects(channel, checkAfterReconnect);
  gate = createUnlockGate({
    holdsWallet,
    shownWalletId: getShownWalletId,
    showsWalletContent,
    isStarted: () => store.getState().global.isReady,
    isUnlocked: () => store.getState().global.isUnlocked,
    wallet: reads,
    onUnknown: checkAfterReconnect,
    refusal: () => 'The selected wallet is no longer available'
  });
  let stopListening = () => undefined as void;
  if (accountUpdater) {
    render(
      <Provider store={store}>
        <WalletProvider wallet={wallet as unknown as Parameters<typeof WalletProvider>[0]['wallet']}>
          <AccountUpdater />
        </WalletProvider>
      </Provider>
    );
  } else {
    // What the account updater does with these two, without its reads.
    const unlocked = () => store.dispatch(globalActions.update({ isUnlocked: true }));
    const locked = () => store.dispatch(globalActions.update({ isUnlocked: false }));
    uiEventBus.addEventListener(BUS_METHODS.UNLOCKED, unlocked);
    uiEventBus.addEventListener(BUS_METHODS.LOCKED, locked);
    stopListening = () => {
      uiEventBus.removeEventListener(BUS_METHODS.UNLOCKED, unlocked);
      uiEventBus.removeEventListener(BUS_METHODS.LOCKED, locked);
    };
  }
  // The page's unlock, as useUnlockCallback makes it: the store records the
  // unlock, and the screens show accounts, once wallet.unlock has answered.
  const unlock = (password: string) =>
    wallet.unlock(password).then(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }));
    });
  const uninstall = () => {
    uninstallHandler();
    stopListening();
  };
  return { wallet, unlock, reload, reloadOnBoot, storageAtReopen, uninstall };
}

// How `promise` stands once everything due has run.
async function standing(promise: Promise<unknown>) {
  let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
  let error: unknown;
  void promise.then(
    () => (outcome = 'resolved'),
    (failure: unknown) => {
      outcome = 'rejected';
      error = failure;
    }
  );
  await settle();
  return { outcome, error };
}

// A window that missed a reset while its connection was down still shows the
// erased wallet; a wallet was made since in another window, in the same slot.
// Unlocked with that wallet's password, it would go on showing the erased
// account: its start-up keeps the account it loaded, and its account updates
// reload the wallets only for an account of another key, which the new
// wallet's first account does not have.
describe('a window whose wallet was replaced while its connection was down', () => {
  let uninstall: (() => void) | undefined;
  // What a background still starting answers: its keyring store is not loaded.
  const notLoaded = { err: { message: 'Cannot read properties of undefined (reading getState)' } };

  beforeEach(() => {
    vi.useFakeTimers();
    ports.length = 0;
    localStorage.clear();
    forgetShownWalletId();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    cleanup();
    vi.useRealTimers();
    forgetShownWalletId();
    localStorage.clear();
  });

  // The reconnection check could not tell; the page then sits on its unlock
  // screen, and port 1 is its connection.
  async function staleWindowAfterAnUnknownCheck() {
    const store = windowOnTheUnlockScreen();
    recordShownWalletId('wallet-erased');
    // The display preferences the windows of the new wallet saved.
    localStorage.setItem(SAVED_UI_KEY, '{"isBalanceHidden":false,"balanceDetailExpanded":false}');
    localStorage.setItem('written_by_the_new_wallet', '1');
    // The background keeps starting past the wait for it.
    const page = windowWithItsChecks(store, async () => false);
    uninstall = page.uninstall;
    port(0).drop();
    void page.wallet.setLastActiveTime().catch(() => undefined);
    await settle();
    port(1).respond('isBooted', notLoaded);
    port(1).respond('getWalletId', notLoaded);
    await settle();
    expect(page.reloadOnBoot).not.toHaveBeenCalled();
    return { store, page };
  }

  // Nothing of the erased wallet was shown, nor is left to show.
  function expectReopenedWithNothingShown(
    store: ReturnType<typeof createAppStore>,
    page: { reloadOnBoot: ReturnType<typeof vi.fn>; storageAtReopen: Record<string, string>[] }
  ) {
    expect(page.reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/');
    expect(store.getState().global.isUnlocked).toBe(false);
    expect(store.getState().accounts.current.address).toBe('');
    expect(store.getState().keyrings.keyrings).toEqual([]);
    // Nothing of its send form is left in its memory, nor saved; the display
    // preferences the new wallet's windows saved stay theirs.
    expect(store.getState().ui.uiTxCreateScreen.toInfo.address).toBe('');
    expect(store.getState().ui.addressInput.address).toBe('');
    expect(store.getState().ui.sendFormScope).toBeNull();
    noDraftSaved();
    expect(page.storageAtReopen[0]?.[SAVED_UI_KEY]).toBe('{"isBalanceHidden":false,"balanceDetailExpanded":false}');
    expect(createAppStore().getState().ui.uiTxCreateScreen.toInfo.address).toBe('');
    expect(localStorage.getItem('written_by_the_new_wallet')).toBe('1');
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
  }

  it('reopens on the boot route at its own unlock, before it shows the old account', async () => {
    const { store, page } = await staleWindowAfterAnUnknownCheck();

    const unlocking = page.unlock('the new wallet password');
    port(1).respond('unlock', { res: undefined });
    await settle();
    expect(port(1).methods().slice(-2)).toEqual(['isBooted', 'getWalletId']);
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-new' });
    await settle();

    expectReopenedWithNothingShown(store, page);
    expect(createAppStore().getState().ui.uiTxCreateScreen.toInfo.address).toBe('');
    expect(page.reload).not.toHaveBeenCalled();
    // The unlock still ends, should the page not be taken by the reload.
    expect((await standing(unlocking)).outcome).toBe('pending');
    await settle(UNLOCK_REOPEN_WAIT_MS);
    const { outcome, error } = await standing(unlocking);
    expect(outcome).toBe('rejected');
    expect(isShownWalletGoneError(error)).toBe(true);
  });

  it('reopens on the boot route at its own unlock when the background announces the unlock first', async () => {
    const { store, page } = await staleWindowAfterAnUnknownCheck();

    const unlocking = page.unlock('the new wallet password').catch(() => undefined);
    // The keyring announces the unlock before the request is answered.
    port(1).broadcast(BUS_METHODS.UNLOCKED);
    await settle();
    expect(store.getState().global.isUnlocked).toBe(false);
    expect(port(1).methods().slice(-2)).toEqual(['isBooted', 'getWalletId']);
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-new' });
    await settle();
    port(1).respond('unlock', { res: undefined });
    await settle(UNLOCK_REOPEN_WAIT_MS);
    await unlocking;

    expectReopenedWithNothingShown(store, page);
    // Its account updater never saw the unlock: no balance read went out.
    expect(
      port(1)
        .methods()
        .filter((method) => !['isBooted', 'getWalletId'].includes(method))
    ).toEqual(['setLastActiveTime', 'unlock']);
  });

  it('reopens on the boot route when another window unlocks the wallet made since', async () => {
    const { store, page } = await staleWindowAfterAnUnknownCheck();

    port(1).broadcast(BUS_METHODS.UNLOCKED);
    await settle();
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-new' });
    await settle();

    expectReopenedWithNothingShown(store, page);
  });

  it('reopens on the boot route after a reconnection that finds another id', async () => {
    const store = windowOnTheUnlockScreen();
    recordShownWalletId('wallet-erased');
    const page = windowWithItsChecks(store);
    uninstall = page.uninstall;

    port(0).drop();
    void page.wallet.setLastActiveTime().catch(() => undefined);
    await settle();
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-new' });
    await settle();

    expect(page.reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(store.getState().accounts.current.address).toBe('');
  });
});

describe('a window that holds the wallet the background holds', () => {
  let uninstall: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    ports.length = 0;
    localStorage.clear();
    forgetShownWalletId();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    cleanup();
    vi.useRealTimers();
    forgetShownWalletId();
    localStorage.clear();
  });

  function healthyWindow() {
    const store = windowOnTheUnlockScreen();
    recordShownWalletId('wallet-kept');
    const page = windowWithItsChecks(store);
    uninstall = page.uninstall;
    return { store, page };
  }

  function expectNothingChanged(
    store: ReturnType<typeof createAppStore>,
    page: { reloadOnBoot: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> }
  ) {
    expect(page.reloadOnBoot).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
    expect(store.getState().global.isUnlocked).toBe(true);
    expect(store.getState().accounts.current.address).toBe(account.address);
    expect(store.getState().ui.uiTxCreateScreen.toInfo.address).toBe(DRAFT_ADDRESS);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
  }

  it('unlocks as before at its own unlock, the background announcing it first', async () => {
    const { store, page } = healthyWindow();

    const unlocking = page.unlock('its password');
    port(0).broadcast(BUS_METHODS.UNLOCKED);
    await settle();
    port(0).respond('isBooted', { res: true });
    port(0).respond('getWalletId', { res: 'wallet-kept' });
    await settle();
    expect(store.getState().global.isUnlocked).toBe(true);
    port(0).respond('unlock', { res: undefined });
    await settle();
    port(0).respond('isBooted', { res: true });
    port(0).respond('getWalletId', { res: 'wallet-kept' });
    await act(async () => {
      await unlocking;
    });

    expectNothingChanged(store, page);
  });

  it('unlocks as before when another window unlocks the wallet', async () => {
    const { store, page } = healthyWindow();

    port(0).broadcast(BUS_METHODS.UNLOCKED);
    await settle();
    port(0).respond('isBooted', { res: true });
    port(0).respond('getWalletId', { res: 'wallet-kept' });
    await settle();

    expectNothingChanged(store, page);
  });

  it('keeps everything after a reconnection and an unlock that find the same id', async () => {
    const { store, page } = healthyWindow();

    port(0).drop();
    const unlocking = page.unlock('its password');
    port(1).respond('unlock', { res: undefined });
    await settle();
    // The check after the reconnection, then the one the unlock makes.
    expect(port(1).methods()).toEqual(['unlock', 'isBooted', 'getWalletId', 'isBooted', 'getWalletId']);
    for (let check = 0; check < 2; check++) {
      port(1).respond('isBooted', { res: true });
      port(1).respond('getWalletId', { res: 'wallet-kept' });
    }
    await act(async () => {
      await unlocking;
    });

    expectNothingChanged(store, page);
  });
});

describe('a window after an ordinary removal of a wallet that is not the current one', () => {
  let uninstall: (() => void) | undefined;
  const second = { ...account, address: 'qb1zsecondaccount', pubkey: '02second', key: 'keyring_1#0' };
  const secondKeyring = { ...keyring, accounts: [second], alianName: 'Spending', index: 1, key: 'keyring_1' };

  beforeEach(() => {
    vi.useFakeTimers();
    ports.length = 0;
    localStorage.clear();
    forgetShownWalletId();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    cleanup();
    vi.useRealTimers();
    forgetShownWalletId();
    localStorage.clear();
  });

  it('reloads nothing through a lock, an unlock the background announces, and a reconnection', async () => {
    const store = windowOnTheUnlockScreen();
    store.dispatch(keyringsActions.setKeyrings([keyring, secondKeyring]));
    store.dispatch(accountActions.setAccounts([account, second]));
    store.dispatch(globalActions.update({ isUnlocked: true }));
    recordShownWalletId('wallet-kept');
    const page = windowWithItsChecks(store, undefined, { accountUpdater: false });
    uninstall = page.uninstall;

    // The removal dialog updates the wallets and the current one only: the
    // account list still holds the removed wallet's account.
    act(() => {
      store.dispatch(keyringsActions.setKeyrings([keyring]));
      store.dispatch(keyringsActions.setCurrent(keyring));
    });
    expect(store.getState().accounts.accounts.map(({ address }) => address)).toContain(second.address);

    // An auto-lock, then an unlock on this page, announced first.
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: false }));
    });
    const unlocking = page.unlock('its password');
    port(0).broadcast(BUS_METHODS.UNLOCKED);
    await settle();
    port(0).respond('isBooted', { res: true });
    port(0).respond('getWalletId', { res: 'wallet-kept' });
    await settle();
    port(0).respond('unlock', { res: undefined });
    await settle();
    port(0).respond('isBooted', { res: true });
    port(0).respond('getWalletId', { res: 'wallet-kept' });
    await act(async () => {
      await unlocking;
    });
    expect(store.getState().global.isUnlocked).toBe(true);
    // And a restart of the background: the next request reconnects.
    port(0).drop();
    void page.wallet.getAccounts().catch(() => undefined);
    await settle();
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-kept' });
    await settle();

    expect(page.reloadOnBoot).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
    expect(store.getState().accounts.current.address).toBe(account.address);
    expect(store.getState().keyrings.keyrings).toHaveLength(1);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
  });
});
