import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChainType } from '@qbit/wallet-types';
import { ErrorCodes } from '@qbit/wallet-shared';
import {
  accountActions,
  createAppStore,
  globalActions,
  ToolsContext,
  transactionsActions,
  WalletProvider
} from '@qbit/wallet-state';

// The real store and reducers, from the package build (run `pnpm build` first).
vi.mock('@qbit/wallet-state', () => import('../../../packages/wallet-state/lib/index.mjs'));
// What the start-up error screen's Retry would call; nothing here may.
vi.mock('@/background/webapi/browser', () => ({ browserRuntimeReload: vi.fn() }));

import englishMessages from '@/_locales/en/messages.json';
import { browserRuntimeReload } from '@/background/webapi/browser';
import { i18nService } from '@/shared/utils/i18n';

import {
  PAGE_STARTUP_RETRY_DELAYS_MS,
  PAGE_WALLET_ID_RETRY_DELAYS_MS,
  PageStartup
} from '../src/ui/components/PageStartup';
import { WAITING_PAGE_SPINNER_DELAY_MS } from '../src/ui/components/WaitingPage';
import {
  checkShownWallet,
  createReconnectReconcile,
  createUnlockGate,
  createWalletResetHandler,
  forgetShownWalletId,
  forgetWalletDataOwnerAtLoad,
  getShownWalletId,
  installWalletResetHandler,
  noteWalletDataOwnerAtLoad,
  pageShowsWalletContent,
  refuseWithoutWalletId,
  WALLET_DATA_OWNER_KEY,
  WALLET_DATA_RESET_MARK,
  WALLET_ID_MISSING_REOPEN_KEY
} from '../src/ui/utils/walletReset';
import { noteWalletActivity } from '../src/ui/utils/walletActivity';
import { sendUnderWalletIdRule } from '../src/ui/web/ui-messaging';

// How a page receives the background's refusal of a call it held while a
// completion of a reset cleared wallet data: the error's message and stack.
const REFUSED = {
  message: 'Qbit Wallet was reset before this request ran, so it did not run',
  stack: 'Error: Qbit Wallet was reset before this request ran, so it did not run'
};

const account = {
  address: 'qb1zstartupaccount',
  alianName: 'Account 1',
  flag: 0,
  index: 0,
  key: 'keyring_0#0',
  pubkey: '02start',
  type: 'Qbit HD Key Tree'
};

// The reads a page makes as it starts.
const READS = [
  'getWalletId',
  'getCurrentAccount',
  'getAccounts',
  'getChainType',
  'getLocale',
  'getSkippedVersion',
  'getAutoLockTimeId',
  'getDeveloperMode',
  'hasVault',
  'isUnlocked'
] as const;

/** A background that answers every read, for a locked wallet. */
function background() {
  return {
    getWalletId: vi.fn(async (): Promise<string | null> => 'wallet-1'),
    getCurrentAccount: vi.fn(async (): Promise<typeof account | null> => account),
    getAccounts: vi.fn(async () => [account]),
    getChainType: vi.fn(async () => ChainType.QBIT_REGTEST),
    getLocale: vi.fn(async () => 'fr'),
    getSkippedVersion: vi.fn(async () => '1.0.8'),
    getAutoLockTimeId: vi.fn(async () => 3),
    getDeveloperMode: vi.fn(async () => true),
    hasVault: vi.fn(async () => true),
    isUnlocked: vi.fn(async () => false),
    getKeyrings: vi.fn(async () => [{ key: 'keyring_0', index: 0, accounts: [account] }]),
    getCurrentKeyring: vi.fn(async () => ({ key: 'keyring_0', index: 0, accounts: [account] }))
  };
}
type Background = ReturnType<typeof background>;

/**
 * The background finishes a pending reset, from a boot on another page: it
 * holds this page's calls until it ends, then refuses them. Returns its end.
 */
function finishingAPendingReset(wallet: Background): () => void {
  let end!: () => void;
  const completion = { clearing: true, ended: new Promise<void>((resolve) => (end = resolve)) };
  for (const read of READS) {
    const answer = wallet[read].getMockImplementation() as () => Promise<unknown>;
    (wallet[read] as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!completion.clearing) return answer();
      await completion.ended;
      throw REFUSED;
    });
  }
  return () => {
    completion.clearing = false;
    end();
  };
}

function openPage(wallet: Background) {
  const store = createAppStore();
  const page = render(
    <Provider store={store}>
      <WalletProvider wallet={wallet as unknown as Parameters<typeof WalletProvider>[0]['wallet']}>
        <PageStartup>
          <span data-testid="wallet-pages" />
        </PageStartup>
      </WalletProvider>
    </Provider>
  );
  return { store, page };
}

const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const showsWalletPages = () => screen.queryByTestId('wallet-pages') !== null;
const showsSpinner = (page: ReturnType<typeof render>) => page.container.querySelector('.icon-spin') !== null;
const showsStartupError = () => screen.queryByText('Qbit Wallet could not start') !== null;
const ALL_PAUSES_MS = PAGE_STARTUP_RETRY_DELAYS_MS.reduce((total, pause) => total + pause, 0);

describe('a page starting', () => {
  beforeAll(() => {
    // Every locale bundle is served in English.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => englishMessages }))
    );
    i18nService.init({});
  });

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    forgetShownWalletId();
    forgetWalletDataOwnerAtLoad();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    forgetShownWalletId();
    forgetWalletDataOwnerAtLoad();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('starts in one run with no pause when the background answers', async () => {
    const wallet = background();
    const { store, page } = openPage(wallet);
    // A start-up this quick shows no spinner.
    expect(showsSpinner(page)).toBe(false);

    await settle();

    expect(showsWalletPages()).toBe(true);
    for (const read of READS) {
      expect(wallet[read], read).toHaveBeenCalledTimes(1);
    }
    const { global, settings, accounts } = store.getState();
    expect(global).toMatchObject({ isReady: true, isBooted: true, isUnlocked: false });
    expect(settings).toMatchObject({
      chainType: ChainType.QBIT_REGTEST,
      locale: 'fr',
      skippedVersion: '1.0.8',
      autoLockTimeId: 3,
      developerMode: true
    });
    expect(accounts.current.address).toBe(account.address);
    // The id of the wallet set up, read before the account loaded with it.
    expect(getShownWalletId()).toBe('wallet-1');
    const [idRead] = wallet.getWalletId.mock.invocationCallOrder;
    const [accountRead] = wallet.getCurrentAccount.mock.invocationCallOrder;
    expect(idRead).toBeLessThan(accountRead ?? 0);
  });

  it('starts once the completion of a reset that refused its first run has ended', async () => {
    const wallet = background();
    const endCompletion = finishingAPendingReset(wallet);
    const { store, page } = openPage(wallet);

    // Its first reads, the wallet's id first, wait for the completion to end.
    await settle(5_000);
    expect(showsSpinner(page)).toBe(true);
    expect(wallet.getWalletId).toHaveBeenCalledTimes(1);
    expect(wallet.getCurrentAccount).toHaveBeenCalledTimes(1);

    // It ends, refusing them, and announces nothing to this page.
    endCompletion();
    await settle();
    expect(store.getState().global.isReady).toBe(false);
    expect(showsSpinner(page)).toBe(true);
    expect(showsStartupError()).toBe(false);

    // The next run, after a short pause, starts the page.
    await settle(PAGE_STARTUP_RETRY_DELAYS_MS[0]);
    expect(showsWalletPages()).toBe(true);
    expect(store.getState().global).toMatchObject({ isReady: true, isBooted: true, isUnlocked: false });
    // Refused with the id, the other reads failed the first run too.
    expect(wallet.getWalletId).toHaveBeenCalledTimes(2);
    expect(wallet.getCurrentAccount).toHaveBeenCalledTimes(2);
    expect(getShownWalletId()).toBe('wallet-1');
    // The settings it reads without waiting arrive just after.
    await settle();
    expect(store.getState().settings.developerMode).toBe(true);
  });

  it('gives up after the last pause and shows the start-up error, not a spinner', async () => {
    const wallet = background();
    for (const read of READS) {
      (wallet[read] as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(REFUSED);
    }
    const { store, page } = openPage(wallet);

    await settle(ALL_PAUSES_MS - 1);
    expect(showsSpinner(page)).toBe(true);
    expect(showsStartupError()).toBe(false);
    expect(wallet.getWalletId).toHaveBeenCalledTimes(PAGE_STARTUP_RETRY_DELAYS_MS.length);

    await settle(1);
    expect(showsStartupError()).toBe(true);
    expect(screen.getByText('Something went wrong while Qbit Wallet was starting.')).toBeTruthy();
    expect(showsSpinner(page)).toBe(false);
    expect(wallet.getWalletId).toHaveBeenCalledTimes(PAGE_STARTUP_RETRY_DELAYS_MS.length + 1);

    // It asks no more, and restarts nothing.
    await settle(10 * 60_000);
    expect(wallet.getWalletId).toHaveBeenCalledTimes(PAGE_STARTUP_RETRY_DELAYS_MS.length + 1);
    expect(store.getState().global.isReady).toBe(false);
    expect(browserRuntimeReload).not.toHaveBeenCalled();
  });

  it('gives up the same way when the reads fail for another reason', async () => {
    const wallet = background();
    wallet.getLocale.mockRejectedValue({ message: 'The connection to Qbit Wallet closed' });
    openPage(wallet);

    await settle(ALL_PAUSES_MS);

    expect(showsStartupError()).toBe(true);
    expect(wallet.getLocale).toHaveBeenCalledTimes(PAGE_STARTUP_RETRY_DELAYS_MS.length + 1);
    // What loaded is not read again; the account goes with the id, which no
    // run that failed could record.
    expect(wallet.hasVault).toHaveBeenCalledTimes(1);
    expect(getShownWalletId()).toBeUndefined();
  });

  it('keeps a started page as it is when a later run is refused', async () => {
    // The first-run page, with no wallet yet, as Create Password shows it.
    const wallet = background();
    wallet.getCurrentAccount.mockResolvedValue(null);
    wallet.hasVault.mockResolvedValue(false);
    const { store } = openPage(wallet);
    await settle();
    expect(showsWalletPages()).toBe(true);

    // Its boot finishes a pending reset, and the routine runs again meanwhile.
    wallet.getCurrentAccount.mockRejectedValue(REFUSED);
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }));
    });
    await settle(ALL_PAUSES_MS + 60_000);

    expect(showsWalletPages()).toBe(true);
    expect(showsStartupError()).toBe(false);
    expect(browserRuntimeReload).not.toHaveBeenCalled();
  });

  it('stops trying once the page is closed', async () => {
    const wallet = background();
    wallet.getCurrentAccount.mockRejectedValue(REFUSED);
    const { page } = openPage(wallet);
    await settle();
    expect(wallet.getCurrentAccount).toHaveBeenCalledTimes(1);

    page.unmount();
    await settle(ALL_PAUSES_MS + 60_000);

    expect(wallet.getCurrentAccount).toHaveBeenCalledTimes(1);
  });

  it('records no id while nothing is booted, and records it once booted, reading the account again after it', async () => {
    // The first-run page.
    const wallet = background();
    wallet.getWalletId.mockResolvedValue(null);
    wallet.getCurrentAccount.mockResolvedValue(null);
    wallet.hasVault.mockResolvedValue(false);
    const { store } = openPage(wallet);
    await settle();
    expect(showsWalletPages()).toBe(true);
    expect(getShownWalletId()).toBeUndefined();

    // It boots and makes its first wallet, which marks it unlocked.
    wallet.getWalletId.mockResolvedValue('wallet-made-here');
    wallet.getCurrentAccount.mockResolvedValue(account);
    const accountReadsBefore = wallet.getCurrentAccount.mock.calls.length;
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }));
    });
    await settle();

    expect(getShownWalletId()).toBe('wallet-made-here');
    expect(wallet.getCurrentAccount.mock.calls.length).toBeGreaterThan(accountReadsBefore);
    const idRead = wallet.getWalletId.mock.invocationCallOrder.at(-1) ?? Infinity;
    expect(wallet.getCurrentAccount.mock.invocationCallOrder.at(-1)).toBeGreaterThan(idRead);
    expect(store.getState().accounts.current.address).toBe(account.address);
  });

  // Create Password boots the background, which then has an id, unlocked,
  // with no wallet yet: it names no account and has no vault. That is not a
  // locked wallet.
  it('stays unlocked on the first-run page once Create Password has booted the background, recording its id', async () => {
    const wallet = background();
    wallet.getWalletId.mockResolvedValue(null);
    wallet.getCurrentAccount.mockResolvedValue(null);
    wallet.getAccounts.mockResolvedValue([]);
    wallet.hasVault.mockResolvedValue(false);
    const { store } = openPage(wallet);
    await settle();

    // The boot's UNLOCKED, as AccountUpdater takes it.
    wallet.getWalletId.mockResolvedValue('wallet-booted');
    wallet.isUnlocked.mockResolvedValue(true);
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }));
    });
    await settle();

    expect(getShownWalletId()).toBe('wallet-booted');
    expect(store.getState().global).toMatchObject({ isReady: true, isBooted: false, isUnlocked: true });
  });

  it('opens although a settings read keeps failing, which keeps its default and is read again later', async () => {
    const wallet = background();
    wallet.getDeveloperMode.mockRejectedValue({ message: 'The connection to Qbit Wallet closed' });
    const { store } = openPage(wallet);

    await settle();

    expect(showsWalletPages()).toBe(true);
    expect(showsStartupError()).toBe(false);
    expect(store.getState().settings.developerMode).toBe(false);
    expect(store.getState().settings.skippedVersion).toBe('1.0.8');
    // The run its readiness starts reads it again.
    expect(wallet.getDeveloperMode.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(wallet.getSkippedVersion).toHaveBeenCalledTimes(1);
  });

  it('opens without waiting for a settings read that never answers, and does not ask again while it is out', async () => {
    const wallet = background();
    wallet.getAutoLockTimeId.mockReturnValue(new Promise<number>(() => undefined));
    const { store } = openPage(wallet);

    await settle();
    expect(showsWalletPages()).toBe(true);
    act(() => {
      store.dispatch(globalActions.update({ isUnlocked: true }));
    });
    await settle();

    expect(wallet.getAutoLockTimeId).toHaveBeenCalledTimes(1);
  });

  it('runs one start-up at a time: a change during a run starts the next one after it', async () => {
    const wallet = background();
    let answer!: (value: typeof account) => void;
    wallet.getCurrentAccount.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    // Its own dispatch of the lock state changes the routine while it waits.
    wallet.isUnlocked.mockResolvedValue(true);
    openPage(wallet);

    await settle();
    expect(wallet.getCurrentAccount).toHaveBeenCalledTimes(1);
    expect(wallet.getChainType).not.toHaveBeenCalled();

    answer(account);
    await settle();

    expect(showsWalletPages()).toBe(true);
    // The next run read only what had not loaded: no second account read.
    expect(wallet.getCurrentAccount).toHaveBeenCalledTimes(1);
    expect(wallet.getChainType).toHaveBeenCalledTimes(1);
    expect(wallet.getWalletId).toHaveBeenCalledTimes(1);
  });

  it('retries only the start-up of this page from its error screen, and restarts nothing', async () => {
    const wallet = background();
    wallet.getLocale.mockRejectedValue({ message: 'The connection to Qbit Wallet closed' });
    openPage(wallet);
    await settle(ALL_PAUSES_MS);
    expect(showsStartupError()).toBe(true);
    // The hint that Retry restarts Qbit Wallet does not apply here.
    expect(screen.queryByText(/Retry restarts Qbit Wallet/)).toBeNull();

    wallet.getLocale.mockResolvedValue('fr');
    act(() => {
      screen.getByText('Retry').click();
    });
    await settle();

    expect(showsWalletPages()).toBe(true);
    expect(browserRuntimeReload).not.toHaveBeenCalled();
    expect(wallet.getLocale).toHaveBeenCalledTimes(PAGE_STARTUP_RETRY_DELAYS_MS.length + 2);
  });

  it('shows its spinner, on the whole page, only once start-up has taken a second', async () => {
    const wallet = background();
    let answerId!: (id: string) => void;
    wallet.getWalletId.mockImplementationOnce(() => new Promise<string>((resolve) => (answerId = resolve)));
    const { page } = openPage(wallet);

    await settle(WAITING_PAGE_SPINNER_DELAY_MS - 1);
    expect(showsSpinner(page)).toBe(false);
    expect(showsWalletPages()).toBe(false);

    await settle(1);
    expect(showsSpinner(page)).toBe(true);
    const startupPage = page.container.firstElementChild as HTMLElement;
    expect([startupPage.style.width, startupPage.style.height]).toEqual(['100vw', '100vh']);

    answerId('wallet-1');
    await settle();
    expect(showsWalletPages()).toBe(true);
    expect(showsSpinner(page)).toBe(false);
  });

  it('shows its spinner again once a Retry from its error screen has taken a second', async () => {
    const wallet = background();
    wallet.getLocale.mockRejectedValue({ message: 'The connection to Qbit Wallet closed' });
    const { page } = openPage(wallet);
    await settle(ALL_PAUSES_MS);
    expect(showsStartupError()).toBe(true);

    let answerLocale!: (locale: string) => void;
    wallet.getLocale.mockImplementationOnce(() => new Promise<string>((resolve) => (answerLocale = resolve)));
    act(() => {
      screen.getByText('Retry').click();
    });
    await settle(WAITING_PAGE_SPINNER_DELAY_MS - 1);
    expect(showsSpinner(page)).toBe(false);
    expect(showsStartupError()).toBe(false);
    await settle(1);
    expect(showsSpinner(page)).toBe(true);

    answerLocale('fr');
    await settle();
    expect(showsWalletPages()).toBe(true);
  });

  it('offers the restart once a Retry of this page has failed again, as after a failure of the background', async () => {
    const wallet = background();
    wallet.getLocale.mockRejectedValue({ message: 'The connection to Qbit Wallet closed' });
    openPage(wallet);
    await settle(ALL_PAUSES_MS);
    act(() => {
      screen.getByText('Retry').click();
    });
    await settle(ALL_PAUSES_MS);

    expect(showsStartupError()).toBe(true);
    expect(screen.getByText(/Retry restarts Qbit Wallet/)).toBeTruthy();
    act(() => {
      screen.getByText('Retry').click();
    });
    expect(browserRuntimeReload).toHaveBeenCalledTimes(1);
  });

  // The wallet proxy's rule for the id, with the page's real start-up and
  // store: the stand-in background behind sendUnderWalletIdRule, as the UI
  // entry wires the proxy, each call that reaches it recorded with its id.
  describe('the calls a page sends, by the id of the wallet it shows', () => {
    type Reached = { method: string; walletId: string | undefined };
    // A new id's save that fails, as on a store that rejects every write.
    const SAVE_FAILED = { message: 'QUOTA_BYTES quota exceeded' };
    const bus = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const reloadOnBoot = vi.fn();
    let uninstall: () => void;
    // The page's words for a call refused for want of the id (index.tsx).
    const ID_UNREADABLE = englishMessages.wallet_page_id_unreadable.message;
    const ALL_ID_PAUSES_MS = PAGE_WALLET_ID_RETRY_DELAYS_MS.reduce((total, pause) => total + pause, 0);

    // The page as the UI entry wires its wallet proxy. `tools`: the page's
    // toasts, none unless given.
    function openGuardedPage<T extends Record<string, unknown>>(
      wallet: T,
      { tools }: { tools?: { toastError: (content: string) => void } } = {}
    ) {
      const store = createAppStore();
      const reached: Reached[] = [];
      const refusals: unknown[] = [];
      const rule = {
        walletId: getShownWalletId,
        showsWalletContent: () => pageShowsWalletContent(store.getState()),
        refuseWithoutWalletId: () => {
          const refusal = refuseWithoutWalletId(ID_UNREADABLE);
          refusals.push(refusal);
          return refusal;
        }
      };
      const guarded = new Proxy(wallet, {
        get: (target, key) => {
          const member = target[key as string];
          if (typeof key !== 'string' || typeof member !== 'function') return member;
          return (...args: unknown[]) =>
            sendUnderWalletIdRule(key, rule, (walletId) => {
              reached.push({ method: key, walletId });
              return (member as (...callArgs: unknown[]) => Promise<unknown>).apply(target, args);
            });
        }
      }) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const pages = (
        <Provider store={store}>
          <WalletProvider wallet={guarded as unknown as Parameters<typeof WalletProvider>[0]['wallet']}>
            <PageStartup>
              <span data-testid="wallet-pages" />
            </PageStartup>
          </WalletProvider>
        </Provider>
      );
      const page = render(
        tools ? (
          <ToolsContext.Provider value={tools as unknown as Parameters<typeof ToolsContext.Provider>[0]['value']}>
            {pages}
          </ToolsContext.Provider>
        ) : (
          pages
        )
      );
      return { store, guarded, reached, refusals, page };
    }

    // What became of a call: still out, or how it settled.
    function outcome(call: Promise<unknown>) {
      const seen: { state: 'out' | 'sent' | 'refused'; value?: unknown } = { state: 'out' };
      call.then(
        (value) => Object.assign(seen, { state: 'sent', value }),
        (error: unknown) => Object.assign(seen, { state: 'refused', value: error })
      );
      return seen;
    }
    const sentTo = (reached: Reached[], method: string) => reached.filter((call) => call.method === method);
    // What the page shows of a wallet, by the accounts' names and addresses,
    // with the id it holds.
    const shown = (store: ReturnType<typeof createAppStore>) => {
      const { accounts, keyrings } = store.getState();
      const name = (each: { address: string; alianName?: string }) => `${each.alianName ?? ''}@${each.address}`;
      return {
        id: getShownWalletId(),
        current: accounts.current.address === '' ? null : name(accounts.current),
        accounts: accounts.accounts.map(name),
        wallets: keyrings.keyrings.map((keyring) => (keyring.accounts ?? []).map(name))
      };
    };

    // A background with the calls the screens below make.
    const backgroundWithScreens = () =>
      Object.assign(background(), {
        createKeyringWithMnemonics: vi.fn(async () => undefined),
        getAddressBalanceV2: vi.fn(async () => ({ totalBalance: 0 })),
        addContact: vi.fn(async () => true),
        setAccountAlianName: vi.fn(async () => account),
        lockWallet: vi.fn(async () => undefined),
        setLastActiveTime: vi.fn(async () => undefined),
        unlock: vi.fn(async () => undefined)
      });
    type ScreensBackground = ReturnType<typeof backgroundWithScreens>;

    // A page that started unlocked, showing its account, whose id read failed
    // and keeps failing: one retry of it scheduled, none running.
    async function contentWithoutAnId(options?: Parameters<typeof openGuardedPage>[1]) {
      const wallet = backgroundWithScreens();
      wallet.isUnlocked.mockResolvedValue(true);
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      const page = openGuardedPage(wallet, options);
      await settle();
      expect(pageShowsWalletContent(page.store.getState())).toBe(true);
      expect(getShownWalletId()).toBeUndefined();
      return { wallet, ...page };
    }

    // The background set up another wallet than the one the page shows: a
    // reset this page missed erased it, and another window made `id`. The
    // background names `current` as its account while unlocked; locked, it
    // names none and lists none.
    function setUpSince(wallet: ScreensBackground, id: string, current: typeof account, unlocked: boolean) {
      const wallets = [{ key: 'keyring_0', index: 0, accounts: [current] }];
      wallet.getWalletId.mockResolvedValue(id);
      wallet.isUnlocked.mockResolvedValue(unlocked);
      wallet.getCurrentAccount.mockResolvedValue(unlocked ? current : null);
      wallet.getAccounts.mockResolvedValue(unlocked ? [current] : []);
      wallet.getKeyrings.mockResolvedValue(unlocked ? wallets : []);
      wallet.getCurrentKeyring.mockResolvedValue((unlocked ? wallets[0] : null) as never);
    }

    beforeEach(() => {
      reloadOnBoot.mockReset();
      sessionStorage.clear();
      uninstall = installWalletResetHandler(
        createWalletResetHandler({ clearMemory: vi.fn(), reload: vi.fn(), reloadOnBoot }),
        bus
      );
    });

    // Store subscriptions a test makes, released after it whatever its outcome.
    const cleanups: Array<() => void> = [];

    afterEach(() => {
      cleanups.splice(0).forEach((release) => release());
      uninstall();
      sessionStorage.clear();
    });

    it('lets the first-run page go from boot through its first wallet to its first screens: nothing refused, nothing held', async () => {
      const wallet = backgroundWithScreens();
      // Nothing set up yet.
      wallet.getWalletId.mockResolvedValue(null);
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.getAccounts.mockResolvedValue([]);
      wallet.hasVault.mockResolvedValue(false);
      const { store, guarded, reached, refusals } = openGuardedPage(wallet);
      await settle();
      expect(showsWalletPages()).toBe(true);
      expect(pageShowsWalletContent(store.getState())).toBe(false);

      // The first wallet is made on this page; the background then holds it.
      await act(async () => {
        await guarded.createKeyringWithMnemonics('words', "m/87'/0'/0'/0", '', 9, 1);
      });
      wallet.getWalletId.mockResolvedValue('wallet-new');
      wallet.getCurrentAccount.mockResolvedValue(account);
      wallet.getAccounts.mockResolvedValue([account]);
      wallet.hasVault.mockResolvedValue(true);
      wallet.isUnlocked.mockResolvedValue(true);
      // Its first screens ask for the balance as soon as the account shows.
      let balance: Promise<unknown> | undefined;
      let idWhenShown: string | undefined = 'not shown';
      cleanups.push(
        store.subscribe(() => {
          if (balance === undefined && store.getState().accounts.current.address === account.address) {
            idWhenShown = getShownWalletId();
            balance = guarded.getAddressBalanceV2(account.address);
          }
        })
      );
      // As the create hook marks it.
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true, isBooted: true }));
      });
      await settle();

      // The account shows only together with the id read before it.
      expect(idWhenShown).toBe('wallet-new');
      await expect(balance).resolves.toEqual({ totalBalance: 0 });
      expect(sentTo(reached, 'getAddressBalanceV2')).toEqual([
        { method: 'getAddressBalanceV2', walletId: 'wallet-new' }
      ]);
      // What left before the page showed any of a wallet, without an id.
      expect(reached.find((call) => call.method === 'createKeyringWithMnemonics')).toEqual({
        method: 'createKeyringWithMnemonics',
        walletId: undefined
      });
      expect(refusals).toEqual([]);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    // The review's scenario: the id read failed, a reset this page missed
    // erased its wallet and another window made a new one.
    it('sends nothing of a page that shows a wallet without its id to the wallet set up since', async () => {
      const { wallet, store, guarded, reached } = await contentWithoutAnId();
      expect(store.getState().accounts.current.address).toBe(account.address);

      const adding = outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }));
      await settle();

      expect(adding).toMatchObject({
        state: 'refused',
        value: { code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE, message: ID_UNREADABLE }
      });
      expect(wallet.addContact).not.toHaveBeenCalled();
      expect(sentTo(reached, 'addContact')).toEqual([]);
      // Refused at once, and, while the page still asks for its id, without a reload.
      expect(reloadOnBoot).not.toHaveBeenCalled();

      // Once it has stopped asking, the next refusal reopens the page, once.
      await settle(ALL_ID_PAUSES_MS);
      await outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' })).value;
      await settle();
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      expect(wallet.addContact).not.toHaveBeenCalled();
    });

    // Sequence A (the new wallet locked) and sequence B (unlocked), with the
    // new wallet restored from the same seed or made from another: a write
    // made while the page shows the erased wallet, before the retry that
    // reads the new wallet's id, never reaches the new wallet; and the
    // page's accounts and wallets are then the new wallet's, read under its
    // id, or none.
    it.each([
      ['locked', 'another seed'],
      ['locked', 'the same seed'],
      ['unlocked', 'another seed'],
      ['unlocked', 'the same seed']
    ] as const)(
      'sends nothing to a new wallet, %s and from %s, and its accounts and wallets are then those read under its id',
      async (lock, seed) => {
        // The window has used its one reopen already.
        sessionStorage.setItem(WALLET_ID_MISSING_REOPEN_KEY, '1');
        const { wallet, store, guarded, reached } = await contentWithoutAnId();
        expect(shown(store).current).toBe(`Account 1@${account.address}`);

        // During the pause before the retry, the user acts on what the page shows.
        const writes = [
          outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' })),
          outcome(guarded.setAccountAlianName({ address: account.address }, 'Rent'))
        ];
        await settle();

        const newAccount =
          seed === 'the same seed'
            ? { ...account, alianName: 'Restored 1' }
            : { ...account, alianName: 'Other 1', address: 'qb1zotherwallet', pubkey: '02other' };
        setUpSince(wallet, 'wallet-2', newAccount, lock === 'unlocked');
        await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);

        for (const write of writes) {
          expect(write).toMatchObject({ state: 'refused', value: { code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE } });
        }
        expect(wallet.addContact).not.toHaveBeenCalled();
        expect(wallet.setAccountAlianName).not.toHaveBeenCalled();
        expect(sentTo(reached, 'addContact')).toEqual([]);
        expect(sentTo(reached, 'setAccountAlianName')).toEqual([]);

        const newName = `${newAccount.alianName}@${newAccount.address}`;
        if (lock === 'unlocked') {
          expect(shown(store)).toEqual({ id: 'wallet-2', current: newName, accounts: [newName], wallets: [[newName]] });
        } else {
          // Locked, the new wallet names no account: the page shows none, and is locked.
          expect(shown(store)).toEqual({ id: 'wallet-2', current: null, accounts: [], wallets: [] });
          expect(store.getState().global.isUnlocked).toBe(false);
        }
        expect(reloadOnBoot).not.toHaveBeenCalled();
      }
    );

    // The path older than the retries: a call made while a run that reads
    // the id is under way, which then records another wallet's id.
    it('refuses a call made while a run reads the id, which records another wallet: that wallet gets nothing of what the page showed', async () => {
      const { wallet, store, guarded, reached, refusals } = await contentWithoutAnId();
      // A reset this page missed, and a wallet made since; the retry's id
      // read, held while the call comes.
      const other = { ...account, alianName: 'Other 1', address: 'qb1zotherwallet', pubkey: '02other' };
      setUpSince(wallet, 'wallet-2', other, true);
      let answerRetry: ((id: string) => void) | undefined;
      wallet.getWalletId.mockImplementation(() => new Promise<string>((resolve) => (answerRetry = resolve)));
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
      expect(answerRetry).toBeTypeOf('function');
      expect(shown(store).current).toBe(`Account 1@${account.address}`);

      const adding = outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }));
      await settle();
      expect(adding.state).toBe('refused');

      await act(async () => {
        answerRetry?.('wallet-2');
      });
      await settle();

      expect(getShownWalletId()).toBe('wallet-2');
      const otherName = `Other 1@${other.address}`;
      expect(shown(store)).toEqual({
        id: 'wallet-2',
        current: otherName,
        accounts: [otherName],
        wallets: [[otherName]]
      });
      expect(sentTo(reached, 'addContact')).toEqual([]);
      expect(wallet.addContact).not.toHaveBeenCalled();
      expect(refusals).toHaveLength(1);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    // A read that failed once: the page recovers by itself at its next try.
    it('recovers from a one-off failure: the first action is refused with the message, the same action then goes with the id, no reload, no toast', async () => {
      const toastError = vi.fn();
      const { wallet, guarded, reached } = await contentWithoutAnId({ tools: { toastError } });

      // The user's action, and one of the page's own reads.
      const adding = outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }));
      const polling = outcome(guarded.getAddressBalanceV2(account.address));
      await settle();
      expect(adding).toMatchObject({ state: 'refused', value: { message: ID_UNREADABLE } });
      expect(polling.state).toBe('refused');

      wallet.getWalletId.mockResolvedValue('wallet-1');
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
      expect(getShownWalletId()).toBe('wallet-1');

      await expect(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' })).resolves.toBe(true);
      await expect(guarded.getAddressBalanceV2(account.address)).resolves.toEqual({ totalBalance: 0 });
      expect(sentTo(reached, 'addContact')).toEqual([{ method: 'addContact', walletId: 'wallet-1' }]);
      expect(toastError).not.toHaveBeenCalled();
      expect(reloadOnBoot).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBeNull();
    });

    it('tells the user once when its retries give up after refusing calls, then once per refusal after its one reopen', async () => {
      // A page reopened in this window for that already.
      sessionStorage.setItem(WALLET_ID_MISSING_REOPEN_KEY, '1');
      const toastError = vi.fn();
      const { guarded } = await contentWithoutAnId({ tools: { toastError } });

      // The page's own reads, again and again, while it asks for its id.
      for (let poll = 0; poll < 5; poll += 1) {
        await outcome(guarded.getAddressBalanceV2(account.address)).value;
        await settle(10_000);
      }
      expect(toastError).not.toHaveBeenCalled();

      await settle(ALL_ID_PAUSES_MS);
      expect(toastError.mock.calls).toEqual([[ID_UNREADABLE]]);

      const first = outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }));
      const second = outcome(guarded.setAccountAlianName({ address: account.address }, 'Rent'));
      await settle();
      expect(first).toMatchObject({ state: 'refused', value: { message: ID_UNREADABLE } });
      expect(second).toMatchObject({ state: 'refused', value: { message: ID_UNREADABLE } });
      expect(toastError).toHaveBeenCalledTimes(3);
      expect(reloadOnBoot).not.toHaveBeenCalled();
      // Not for what it drops, nor for what it sends.
      noteWalletActivity(guarded as unknown as Parameters<typeof noteWalletActivity>[0]);
      await guarded.lockWallet();
      expect(toastError).toHaveBeenCalledTimes(3);
    });

    it('stops telling once the page has closed', async () => {
      sessionStorage.setItem(WALLET_ID_MISSING_REOPEN_KEY, '1');
      const toastError = vi.fn();
      await contentWithoutAnId({ tools: { toastError } });
      await settle(ALL_ID_PAUSES_MS);
      refuseWithoutWalletId(ID_UNREADABLE);
      expect(toastError).toHaveBeenCalledTimes(1);

      cleanup();
      refuseWithoutWalletId(ID_UNREADABLE);
      expect(toastError).toHaveBeenCalledTimes(1);
    });

    it('leaves no retry behind once the page has closed, and asks no more', async () => {
      const { wallet } = await contentWithoutAnId();
      const reads = wallet.getWalletId.mock.calls.length;

      cleanup();
      await settle(10 * 60_000);

      expect(wallet.getWalletId).toHaveBeenCalledTimes(reads);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['/index.html', '/notification.html'])(
      'sends at once, with the id, from a page that holds one: %s',
      async (path) => {
        window.history.replaceState(null, '', path);
        const wallet = backgroundWithScreens();
        wallet.isUnlocked.mockResolvedValue(true);
        const { guarded, reached } = openGuardedPage(wallet);
        await settle();
        expect(getShownWalletId()).toBe('wallet-1');

        void guarded.addContact({ address: 'qb1zfriend', name: 'Friend' });

        expect(reached.at(-1)).toEqual({ method: 'addContact', walletId: 'wallet-1' });
        window.history.replaceState(null, '', '/');
      }
    );

    it('sends the unlock of a page opened locked: with the id it read, or without one when the read failed', async () => {
      // Locked: the background names no account and lists none.
      for (const idRead of ['works', 'fails'] as const) {
        const wallet = backgroundWithScreens();
        wallet.getCurrentAccount.mockResolvedValue(null);
        wallet.getAccounts.mockResolvedValue([]);
        if (idRead === 'fails') wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
        const { store, guarded, reached, refusals } = openGuardedPage(wallet);
        await settle();
        expect(pageShowsWalletContent(store.getState())).toBe(false);

        await guarded.unlock('its password');

        expect(reached.filter((call) => call.method === 'unlock')).toEqual([
          { method: 'unlock', walletId: idRead === 'works' ? 'wallet-1' : undefined }
        ]);
        expect(refusals).toEqual([]);
        cleanup();
        forgetShownWalletId();
      }
    });

    // The lock and the background's LOCKED, as the Lock button and
    // AccountUpdater make them: the lock, and the handler's question whether
    // a vault is there (publishVault).
    async function lockAsTheLockButtonDoes(
      wallet: ScreensBackground,
      store: ReturnType<typeof createAppStore>,
      guarded: Record<string, (...args: unknown[]) => Promise<unknown>>,
      // How the locked background answers for the current account: none.
      currentAccountWhileLocked: () => Promise<null> = async () => null
    ) {
      wallet.lockWallet.mockImplementation(async () => {
        // Locked, the background names no account and lists none.
        wallet.isUnlocked.mockResolvedValue(false);
        wallet.getCurrentAccount.mockImplementation(currentAccountWhileLocked);
        wallet.getAccounts.mockResolvedValue([]);
      });
      let vault: unknown;
      await act(async () => {
        await guarded.lockWallet();
        store.dispatch(globalActions.update({ isUnlocked: false }));
        vault = await guarded.hasVault();
      });
      return vault;
    }

    it('locks: the lock and the LOCKED handler read go out without an id, and the page ends locked, nothing refused, its reopen unused', async () => {
      const { wallet, store, guarded, reached, refusals } = await contentWithoutAnId();

      const vault = await lockAsTheLockButtonDoes(wallet, store, guarded);
      // The run the lock starts, and the retries after it, still cannot read the id.
      await settle(ALL_ID_PAUSES_MS);

      expect(sentTo(reached, 'lockWallet')).toEqual([{ method: 'lockWallet', walletId: undefined }]);
      expect(sentTo(reached, 'hasVault').at(-1)).toEqual({ method: 'hasVault', walletId: undefined });
      // The first run's read and the LOCKED handler's: a run that could not
      // read the id asks for none.
      expect(wallet.hasVault).toHaveBeenCalledTimes(2);
      expect(vault).toBe(true);
      expect(getShownWalletId()).toBeUndefined();
      // Booted and locked: Layout sends the page to the unlock screen.
      expect(store.getState().global).toMatchObject({ isReady: true, isBooted: true, isUnlocked: false });
      expect(showsWalletPages()).toBe(true);
      expect(refusals).toEqual([]);
      expect(reloadOnBoot).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBeNull();
    });

    // Locked without an id, the page drops what it showed: its unlock then
    // goes as a page opened locked sends it, and the run after the unlock
    // reads the id and the account together.
    it('locks, then unlocks, without an id: nothing refused, no reload, and it ends unlocked with its id and its account read together', async () => {
      const { wallet, store, guarded, reached, refusals } = await contentWithoutAnId();

      // The run the lock starts reads whether the wallet names an account,
      // held here while the page still shows the old one.
      let answerAccount: (() => void) | undefined;
      await lockAsTheLockButtonDoes(
        wallet,
        store,
        guarded,
        () => new Promise((resolve) => (answerAccount = () => resolve(null)))
      );
      expect(answerAccount).toBeTypeOf('function');
      // Until then, nothing of what the page shows goes.
      expect(shown(store).current).toBe(`Account 1@${account.address}`);
      const early = outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }));
      await settle();
      expect(early.state).toBe('refused');
      // Then the page shows none of it: the unlock screen took the place of
      // the screens made from it (Layout), and its store holds nothing of it.
      wallet.getCurrentAccount.mockResolvedValue(null);
      await act(async () => {
        answerAccount?.();
      });
      await settle();
      expect(shown(store)).toEqual({ id: undefined, current: null, accounts: [], wallets: [] });
      expect(pageShowsWalletContent(store.getState())).toBe(false);

      // The background recovers meanwhile; the unlock.
      wallet.getWalletId.mockResolvedValue('wallet-1');
      wallet.unlock.mockImplementation(async () => {
        wallet.isUnlocked.mockResolvedValue(true);
        wallet.getCurrentAccount.mockResolvedValue(account);
        wallet.getAccounts.mockResolvedValue([account]);
      });
      await act(async () => {
        await guarded.unlock('its password');
        // The background's UNLOCKED, as AccountUpdater takes it.
        store.dispatch(globalActions.update({ isUnlocked: true }));
      });
      await settle();

      expect(sentTo(reached, 'unlock')).toEqual([{ method: 'unlock', walletId: undefined }]);
      const name = `Account 1@${account.address}`;
      expect(shown(store)).toEqual({ id: 'wallet-1', current: name, accounts: [name], wallets: [[name]] });
      expect(store.getState().global.isUnlocked).toBe(true);
      const idRead = wallet.getWalletId.mock.invocationCallOrder.at(-1) ?? Infinity;
      expect(wallet.getCurrentAccount.mock.invocationCallOrder.at(-1)).toBeGreaterThan(idRead);
      expect(refusals).toHaveLength(1);
      expect(sentTo(reached, 'addContact')).toEqual([]);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    it('drops its activity pings: nothing sent, refused or rejected, its reopen unused; held with an id, it sends them with it', async () => {
      const { wallet, guarded, reached, refusals } = await contentWithoutAnId();

      // A page that missed a reset pings as the user moves the mouse: the
      // wallet set up since never hears of it, so it auto-locks on time.
      noteWalletActivity(guarded as unknown as Parameters<typeof noteWalletActivity>[0]);
      await expect(guarded.setLastActiveTime()).resolves.toBeUndefined();
      await settle();

      expect(wallet.setLastActiveTime).not.toHaveBeenCalled();
      expect(sentTo(reached, 'setLastActiveTime')).toEqual([]);
      expect(refusals).toEqual([]);
      expect(reloadOnBoot).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBeNull();

      wallet.getWalletId.mockResolvedValue('wallet-1');
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
      expect(getShownWalletId()).toBe('wallet-1');
      noteWalletActivity(guarded as unknown as Parameters<typeof noteWalletActivity>[0]);
      expect(sentTo(reached, 'setLastActiveTime')).toEqual([{ method: 'setLastActiveTime', walletId: 'wallet-1' }]);
    });

    // The cross-wallet guarantee, whatever the lock and the exempt reads let
    // through: no write of a page that shows a wallet without its id leaves.
    it('never sends a write of a page that shows content without an id, lock or no lock', async () => {
      const { wallet, guarded, reached } = await contentWithoutAnId();

      const writes = [
        outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' })),
        outcome(guarded.setAccountAlianName({ address: account.address }, 'Rent'))
      ];
      await act(async () => {
        await guarded.lockWallet();
        await guarded.hasVault();
      });
      await settle();

      for (const write of writes) {
        expect(write).toMatchObject({ state: 'refused', value: { code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE } });
      }
      expect(reached.map((call) => call.method)).not.toContain('addContact');
      expect(reached.map((call) => call.method)).not.toContain('setAccountAlianName');
      expect(wallet.addContact).not.toHaveBeenCalled();
      expect(wallet.setAccountAlianName).not.toHaveBeenCalled();
      expect(sentTo(reached, 'lockWallet')).toHaveLength(1);
    });

    // What the store says of a wallet set up: the background's answer, as of
    // the id the page records, not what the page read when it opened.
    it('ends booted, with the id and the accounts, on a page that opened with nothing set up and learns of a wallet made in another window', async () => {
      const wallet = backgroundWithScreens();
      wallet.getWalletId.mockResolvedValue(null);
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.getAccounts.mockResolvedValue([]);
      wallet.hasVault.mockResolvedValue(false);
      const { store, refusals } = openGuardedPage(wallet);
      await settle();
      expect(store.getState().global.isBooted).toBe(false);

      // Another window makes a wallet and unlocks it: its UNLOCKED reaches this page.
      setUpSince(wallet, 'wallet-1', account, true);
      wallet.hasVault.mockResolvedValue(true);
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true }));
      });
      await settle();

      const name = `Account 1@${account.address}`;
      expect(shown(store)).toEqual({ id: 'wallet-1', current: name, accounts: [name], wallets: [[name]] });
      expect(store.getState().global.isBooted).toBe(true);
      expect(refusals).toEqual([]);
    });

    // Nothing it could turn to takes it off the wallet's screens: no vault,
    // so no unlock screen. Dropping what it shows would let the screens made
    // from it send their calls unjudged (createWalletProxy); so it keeps it,
    // and its store still says what it held, for the checks that go by it.
    it('keeps what it showed, and refuses, once a run of a page without an id finds nothing set up; its next refusal, the retries over, reopens it', async () => {
      const { wallet, store, guarded, reached } = await contentWithoutAnId();
      expect(store.getState().global.isBooted).toBe(true);
      const before = shown(store);

      // A reset this page missed erased every wallet.
      wallet.getWalletId.mockResolvedValue(null);
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.getAccounts.mockResolvedValue([]);
      wallet.hasVault.mockResolvedValue(false);
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);

      expect(shown(store)).toEqual(before);
      expect(store.getState().global).toMatchObject({ isBooted: true, isUnlocked: true });
      expect(reloadOnBoot).not.toHaveBeenCalled();
      // Nothing is booted: the id read answered, no retry is due.
      expect(vi.getTimerCount()).toBe(0);
      const write = outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }));
      await settle();
      expect(write.state).toBe('refused');
      expect(sentTo(reached, 'addContact')).toEqual([]);
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    });

    // The "none" a run read just before a wallet was made is not applied
    // over the isBooted the create hook marks: the run after it goes by the
    // lock-state change, and reads the vault again.
    it('stays booted when a wallet is made while a run that read nothing booted waits for its vault read', async () => {
      const { wallet, store, guarded } = await contentWithoutAnId();
      await lockAsTheLockButtonDoes(wallet, store, guarded);
      await settle();
      expect(store.getState().global).toMatchObject({ isBooted: true, isUnlocked: false });
      expect(pageShowsWalletContent(store.getState())).toBe(false);

      // A reset this page missed erased every wallet. The run the next pause
      // starts reads that nothing is booted, then whether a vault is there:
      // "none", answered only once a wallet has been made since.
      wallet.getWalletId.mockResolvedValue(null);
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.getAccounts.mockResolvedValue([]);
      let answerVault: ((vault: boolean) => void) | undefined;
      wallet.hasVault.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answerVault = resolve)));
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
      expect(answerVault).toBeTypeOf('function');

      // The wallet made on this page, unlocked, as the create hook marks it.
      setUpSince(wallet, 'wallet-new', account, true);
      const booted: boolean[] = [];
      cleanups.push(store.subscribe(() => booted.push(store.getState().global.isBooted)));
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true, isBooted: true }));
      });
      await act(async () => {
        answerVault?.(false);
      });
      await settle();

      expect(booted).not.toContain(false);
      const name = `Account 1@${account.address}`;
      expect(shown(store)).toEqual({ id: 'wallet-new', current: name, accounts: [name], wallets: [[name]] });
      expect(store.getState().global).toMatchObject({ isBooted: true, isUnlocked: true });
    });

    // A lock-state change while a run reads (`again`): this run drops
    // nothing, since it cannot turn the page locked, and the run after it
    // goes by the change. Never content dropped while the page is not on the
    // unlock screen, whose absence would let the screens send unjudged.
    it('drops nothing, and goes on refusing, when its lock state changed while a run that read no account waited', async () => {
      const { wallet, store, guarded, reached } = await contentWithoutAnId();
      const emptied: unknown[] = [];
      cleanups.push(
        store.subscribe(() => {
          if (!pageShowsWalletContent(store.getState())) emptied.push(store.getState().global);
        })
      );
      // The account reads from here on, answered when the test says.
      const accountReads: Array<(answer: typeof account | null) => void> = [];
      wallet.getCurrentAccount.mockImplementation(() => new Promise((resolve) => accountReads.push(resolve)));

      // The wallet locks, unseen; the retry after the first pause asks for the account.
      wallet.isUnlocked.mockResolvedValue(false);
      wallet.getAccounts.mockResolvedValue([]);
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
      expect(accountReads).toHaveLength(1);
      // Meanwhile the page hears of the lock, then of an unlock in another window.
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: false }));
      });
      await settle();
      wallet.isUnlocked.mockResolvedValue(true);
      wallet.getAccounts.mockResolvedValue([account]);
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true }));
      });
      await settle();

      // The waiting run reads that no account is named; the run after it asks again.
      await act(async () => {
        accountReads[0](null);
      });
      await settle();
      expect(accountReads).toHaveLength(2);
      expect(pageShowsWalletContent(store.getState())).toBe(true);
      const writes = [
        outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' })),
        outcome(guarded.setAccountAlianName({ address: account.address }, 'Rent'))
      ];
      await settle();
      expect(writes.map((write) => write.state)).toEqual(['refused', 'refused']);

      // That run reads the account, unlocked.
      await act(async () => {
        accountReads[1](account);
      });
      await settle();

      expect(emptied).toEqual([]);
      expect(shown(store).current).toBe(`Account 1@${account.address}`);
      expect(store.getState().global.isUnlocked).toBe(true);
      expect(sentTo(reached, 'addContact')).toEqual([]);
      expect(sentTo(reached, 'setAccountAlianName')).toEqual([]);
      expect(wallet.addContact).not.toHaveBeenCalled();
      expect(wallet.setAccountAlianName).not.toHaveBeenCalled();
    });

    it('drops the transactions the page held when a run records a late id and reads an account', async () => {
      const { wallet, store } = await contentWithoutAnId();
      act(() => {
        store.dispatch(
          transactionsActions.updateQbitTx({ fromAddress: account.address, toAddress: 'qb1zfriend', toSatoshis: 1_000 })
        );
      });

      const other = { ...account, alianName: 'Other 1', address: 'qb1zotherwallet', pubkey: '02other' };
      setUpSince(wallet, 'wallet-2', other, true);
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);

      expect(getShownWalletId()).toBe('wallet-2');
      expect(shown(store).current).toBe(`Other 1@${other.address}`);
      expect(store.getState().transactions.qbitTx).toMatchObject({ fromAddress: '', toAddress: '', toSatoshis: 0 });
    });

    // A run a lock or an unlock starts after the last retry still reads the
    // id: a call it refuses meanwhile reopens nothing, as during the retries.
    it('reopens nothing, and tells nothing, for a call refused while a run after its last retry reads the id, which it then records', async () => {
      const toastError = vi.fn();
      const { wallet, store, guarded } = await contentWithoutAnId({ tools: { toastError } });
      await settle(ALL_ID_PAUSES_MS);
      // Its retries are over.
      expect(vi.getTimerCount()).toBe(0);
      expect(getShownWalletId()).toBeUndefined();

      // The lock starts a run, whose id read is answered when the test says.
      let answerId: ((id: string) => void) | undefined;
      wallet.getWalletId.mockImplementationOnce(() => new Promise<string>((resolve) => (answerId = resolve)));
      await lockAsTheLockButtonDoes(wallet, store, guarded);
      expect(answerId).toBeTypeOf('function');
      const meanwhile = outcome(guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }));
      await settle();
      expect(meanwhile.state).toBe('refused');

      await act(async () => {
        answerId?.('wallet-1');
      });
      await settle();

      expect(getShownWalletId()).toBe('wallet-1');
      expect(reloadOnBoot).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBeNull();
      expect(toastError).not.toHaveBeenCalled();
    });

    it('clears the pause before its next retry once a run a lock started has recorded the id', async () => {
      const { wallet, store, guarded } = await contentWithoutAnId();
      expect(vi.getTimerCount()).toBe(1);

      wallet.getWalletId.mockResolvedValue('wallet-1');
      await lockAsTheLockButtonDoes(wallet, store, guarded);
      await settle();

      expect(getShownWalletId()).toBe('wallet-1');
      expect(vi.getTimerCount()).toBe(0);
    });

    // The page a first wallet is made on, its id unreadable: the background
    // announces the new account (ACCOUNTS_CHANGED) before the create returns,
    // and the create hook then asks whether the wallet is unlocked.
    it('sends the question the create hook asks, whether the wallet is unlocked, from a first-run page that shows the new account without its id', async () => {
      const wallet = backgroundWithScreens();
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.getAccounts.mockResolvedValue([]);
      wallet.hasVault.mockResolvedValue(false);
      wallet.isUnlocked.mockResolvedValue(true);
      const { store, guarded, reached, refusals } = openGuardedPage(wallet);
      await settle();
      expect(pageShowsWalletContent(store.getState())).toBe(false);

      // ACCOUNTS_CHANGED, as AccountUpdater takes it.
      act(() => {
        store.dispatch(accountActions.setCurrent(account as never));
      });
      expect(pageShowsWalletContent(store.getState())).toBe(true);
      const unlocked = outcome(guarded.isUnlocked());
      await settle();

      expect(unlocked).toEqual({ state: 'sent', value: true });
      expect(sentTo(reached, 'isUnlocked').at(-1)).toEqual({ method: 'isUnlocked', walletId: undefined });
      expect(refusals).toEqual([]);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });
  });

  describe('when the wallet id cannot be read', () => {
    // As when saving a new id keeps failing: the disk is full, say.
    const SAVE_FAILED = { message: 'QUOTA_BYTES quota exceeded' };

    it('opens all the same, holding no id, when the id read fails for its own reason', async () => {
      const wallet = background();
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      openPage(wallet);

      await settle();

      expect(showsWalletPages()).toBe(true);
      expect(showsStartupError()).toBe(false);
      expect(getShownWalletId()).toBeUndefined();
    });

    it('asks again after a pause, and records the id once its save works, its account and wallets read after it', async () => {
      const wallet = background();
      wallet.isUnlocked.mockResolvedValue(true);
      // The save fails until the background recovers; the runs the page's
      // start-up makes, its lock state's included, all fail to read it.
      let saveWorks = false;
      wallet.getWalletId.mockImplementation(async () => {
        if (!saveWorks) throw SAVE_FAILED;
        return 'wallet-1';
      });
      openPage(wallet);
      await settle();
      expect(showsWalletPages()).toBe(true);
      expect(getShownWalletId()).toBeUndefined();

      saveWorks = true;
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);

      expect(getShownWalletId()).toBe('wallet-1');
      const reads = wallet.getWalletId.mock.calls.length;
      const idRead = wallet.getWalletId.mock.invocationCallOrder.at(-1) ?? Infinity;
      expect(wallet.getCurrentAccount.mock.invocationCallOrder.at(-1)).toBeGreaterThan(idRead);
      expect(wallet.getKeyrings.mock.invocationCallOrder.at(-1)).toBeGreaterThan(idRead);
      // Judged by it from then on, as any other page.
      await expect(
        checkShownWallet(getShownWalletId(), { isBooted: async () => true, getWalletId: async () => 'wallet-2' })
      ).resolves.toBe('replaced');
      // Recorded: it asks no more.
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS.reduce((total, pause) => total + pause, 0));
      expect(wallet.getWalletId).toHaveBeenCalledTimes(reads);
    });

    it('asks only a few more times, quietly, when the save keeps failing', async () => {
      const wallet = background();
      wallet.isUnlocked.mockResolvedValue(true);
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      openPage(wallet);
      await settle();
      const atStart = wallet.getWalletId.mock.calls.length;

      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS.reduce((total, pause) => total + pause, 0) + 1_000);
      expect(wallet.getWalletId).toHaveBeenCalledTimes(atStart + PAGE_WALLET_ID_RETRY_DELAYS_MS.length);
      await settle(10 * 60_000);
      expect(wallet.getWalletId).toHaveBeenCalledTimes(atStart + PAGE_WALLET_ID_RETRY_DELAYS_MS.length);
      expect(showsWalletPages()).toBe(true);
      expect(showsStartupError()).toBe(false);
      expect(getShownWalletId()).toBeUndefined();
    });

    // What the page shows cannot be told from another wallet's, so a
    // reconnection reopens it, once: in the page reopened, whose save still
    // fails, the next one changes nothing, and it does not reopen again.
    it('reopens once at a reconnection, and the reopened page, whose save still fails, stays as it is', async () => {
      const wallet = Object.assign(background(), { isBooted: vi.fn(async () => true) });
      wallet.isUnlocked.mockResolvedValue(true);
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      const reconnects = (store: ReturnType<typeof createAppStore>) =>
        createReconnectReconcile({
          holdsWallet: () => true,
          shownWalletId: getShownWalletId,
          showsWalletContent: () => pageShowsWalletContent(store.getState()),
          wallet: { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() },
          waitForStartup: async () => true
        });
      const bus = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
      const firstReload = vi.fn();
      let uninstall = installWalletResetHandler(
        createWalletResetHandler({ clearMemory: vi.fn(), reload: vi.fn(), reloadOnBoot: firstReload }),
        bus
      );
      try {
        const first = openPage(wallet);
        await settle();
        expect(first.store.getState().accounts.current.address).toBe(account.address);

        reconnects(first.store)();
        await settle();
        expect(firstReload).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBe('1');

        // The page reopened in the same window.
        uninstall();
        cleanup();
        forgetShownWalletId();
        const secondReload = vi.fn();
        uninstall = installWalletResetHandler(
          createWalletResetHandler({ clearMemory: vi.fn(), reload: vi.fn(), reloadOnBoot: secondReload }),
          bus
        );
        const second = openPage(wallet);
        await settle();
        expect(getShownWalletId()).toBeUndefined();

        reconnects(second.store)();
        await settle();
        expect(secondReload).not.toHaveBeenCalled();
        expect(showsWalletPages()).toBe(true);
      } finally {
        uninstall();
        sessionStorage.clear();
      }
    });

    // The other way to show wallet content without an id: a page that loaded
    // its account while the id read failed, then locked, the read still
    // failing. Until its run reads that the wallet is locked it still shows
    // the account, and neither a reconnection nor an unlock takes it for up
    // to date; once it has read that, it shows nothing, as a page opened
    // locked, and both go on.
    describe('locked, without an id', () => {
      const bus = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
      const reloadOnBoot = vi.fn();
      let uninstall: () => void;
      const contentOf = (store: ReturnType<typeof createAppStore>) => () => pageShowsWalletContent(store.getState());

      // `holdRead`: the lock's run has not yet read whether the wallet names an account.
      async function lockedWithoutAnId({ holdRead = false } = {}) {
        const wallet = Object.assign(background(), { isBooted: vi.fn(async () => true) });
        wallet.isUnlocked.mockResolvedValue(true);
        wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
        const { store } = openPage(wallet);
        await settle();
        // Locked, the background names no account and lists none.
        wallet.isUnlocked.mockResolvedValue(false);
        wallet.getAccounts.mockResolvedValue([]);
        if (holdRead) {
          wallet.getCurrentAccount.mockImplementation(() => new Promise(() => undefined));
        } else {
          wallet.getCurrentAccount.mockResolvedValue(null);
        }
        act(() => {
          store.dispatch(globalActions.update({ isUnlocked: false }));
        });
        await settle();
        expect(getShownWalletId()).toBeUndefined();
        const reads = { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() };
        return { wallet, store, reads };
      }
      const reconnect = (store: ReturnType<typeof createAppStore>, reads: Parameters<typeof checkShownWallet>[1]) =>
        createReconnectReconcile({
          holdsWallet: () => true,
          shownWalletId: getShownWalletId,
          showsWalletContent: contentOf(store),
          wallet: reads,
          waitForStartup: async () => true
        })();
      const unlockGate = (store: ReturnType<typeof createAppStore>, reads: Parameters<typeof checkShownWallet>[1]) =>
        createUnlockGate({
          holdsWallet: () => true,
          shownWalletId: getShownWalletId,
          showsWalletContent: contentOf(store),
          isStarted: () => store.getState().global.isReady,
          isUnlocked: () => store.getState().global.isUnlocked,
          wallet: reads,
          onUnknown: vi.fn(),
          refusal: () => 'wallet_page_out_of_date'
        });

      beforeEach(() => {
        reloadOnBoot.mockReset();
        sessionStorage.clear();
        uninstall = installWalletResetHandler(
          createWalletResetHandler({ clearMemory: vi.fn(), reload: vi.fn(), reloadOnBoot }),
          bus
        );
      });

      afterEach(() => {
        uninstall();
        sessionStorage.clear();
      });

      it('reopens at a reconnection while it still shows the account', async () => {
        const { store, reads } = await lockedWithoutAnId({ holdRead: true });
        expect(store.getState().accounts.current.address).toBe(account.address);

        reconnect(store, reads);
        await settle();

        expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      });

      it('reopens at an unlock while it still shows the account, which does not go on', async () => {
        const { store, reads } = await lockedWithoutAnId({ holdRead: true });

        let passed: boolean | undefined;
        await act(async () => {
          passed = await unlockGate(store, reads).beforeUnlockedBroadcast();
        });

        expect(passed).toBe(false);
        expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      });

      it('shows nothing once its run has read that the wallet is locked: a reconnection and an unlock then go on', async () => {
        const { store, reads } = await lockedWithoutAnId();
        expect(contentOf(store)()).toBe(false);
        expect(store.getState().accounts.accounts).toEqual([]);
        expect(store.getState().keyrings.keyrings).toEqual([]);

        reconnect(store, reads);
        let passed: boolean | undefined;
        await act(async () => {
          passed = await unlockGate(store, reads).beforeUnlockedBroadcast();
        });
        await settle();

        expect(passed).toBe(true);
        expect(reloadOnBoot).not.toHaveBeenCalled();
      });

      it('compares nothing once it has dropped what it showed and recorded the id', async () => {
        const { wallet, store, reads } = await lockedWithoutAnId();
        wallet.getWalletId.mockResolvedValue('wallet-1');
        await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
        expect(getShownWalletId()).toBe('wallet-1');
        expect(contentOf(store)()).toBe(false);

        reconnect(store, reads);
        await settle();

        // Judged by its id: the same wallet, nothing to do.
        expect(reloadOnBoot).not.toHaveBeenCalled();
      });
    });

    // Unlike a failure of the id read alone: a reset refuses every call a
    // page makes while it runs, the reads that go out with the id read too.
    it('fails the run and retries it when a reset refuses its reads, the id read with them', async () => {
      const wallet = background();
      // The first read of each kind the run sends at once.
      wallet.getWalletId.mockRejectedValueOnce(REFUSED);
      wallet.getCurrentAccount.mockRejectedValueOnce(REFUSED);
      wallet.hasVault.mockRejectedValueOnce(REFUSED);
      const { store } = openPage(wallet);

      await settle();
      expect(store.getState().global.isReady).toBe(false);
      expect(showsWalletPages()).toBe(false);
      expect(getShownWalletId()).toBeUndefined();

      await settle(PAGE_STARTUP_RETRY_DELAYS_MS[0]);
      expect(showsWalletPages()).toBe(true);
      expect(getShownWalletId()).toBe('wallet-1');
      expect(wallet.getWalletId).toHaveBeenCalledTimes(2);
    });

    // A locked wallet names no account and lists no wallets, so a locked page
    // cannot read again what it shows to go with a late id: it drops it, and
    // reads it again after the id at the unlock.
    it('records it while locked, dropping what it shows, which the unlock reads again after it', async () => {
      const wallet = background();
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      wallet.isUnlocked.mockResolvedValue(true);
      const { store } = openPage(wallet);
      await settle();
      expect(showsWalletPages()).toBe(true);
      expect(getShownWalletId()).toBeUndefined();
      expect(store.getState().accounts.current.address).toBe(account.address);

      // A later run, which the lock starts, can read it. Locked, the
      // background names no account and lists none.
      wallet.getWalletId.mockResolvedValue('wallet-1');
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.getAccounts.mockResolvedValue([]);
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: false }));
      });
      await settle();
      expect(getShownWalletId()).toBe('wallet-1');
      expect(store.getState().accounts.current.address).toBe('');
      expect(store.getState().accounts.accounts).toEqual([]);
      expect(store.getState().keyrings.keyrings).toEqual([]);
      const idRead = wallet.getWalletId.mock.invocationCallOrder.at(-1) ?? Infinity;

      wallet.getCurrentAccount.mockResolvedValue(account);
      wallet.getAccounts.mockResolvedValue([account]);
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true }));
      });
      await settle();

      expect(store.getState().accounts.current.address).toBe(account.address);
      expect(wallet.getCurrentAccount.mock.invocationCallOrder.at(-1)).toBeGreaterThan(idRead);
      expect(wallet.getKeyrings.mock.invocationCallOrder.at(-1)).toBeGreaterThan(idRead);
      expect(wallet.getCurrentKeyring).toHaveBeenCalled();
      expect(store.getState().keyrings.keyrings).toHaveLength(1);
      expect(wallet.getWalletId.mock.invocationCallOrder.at(-1)).toBe(idRead);
    });
  });

  it('records the id only with the state read after it: a failed read of the wallets leaves none, and the next run records it', async () => {
    const wallet = background();
    wallet.getWalletId.mockRejectedValue({ message: 'QUOTA_BYTES quota exceeded' });
    wallet.isUnlocked.mockResolvedValue(true);
    const { store } = openPage(wallet);
    await settle();
    expect(showsWalletPages()).toBe(true);
    expect(getShownWalletId()).toBeUndefined();

    // A later run, the first one made again for the id, reads it, but not the
    // wallets that go with it.
    wallet.getWalletId.mockResolvedValue('wallet-1');
    wallet.getKeyrings.mockRejectedValueOnce({ message: 'The connection to Qbit Wallet closed' });
    await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
    expect(getShownWalletId()).toBeUndefined();
    expect(store.getState().global.isUnlocked).toBe(true);

    // The run after it, a short pause later, reads both, and records the id.
    await settle(PAGE_STARTUP_RETRY_DELAYS_MS[0]);
    expect(getShownWalletId()).toBe('wallet-1');
    const keyringsRead = wallet.getKeyrings.mock.invocationCallOrder.at(-1) ?? 0;
    expect(keyringsRead).toBeGreaterThan(wallet.getWalletId.mock.invocationCallOrder.at(-1) ?? Infinity);
  });

  // A reset the background finished at its start, with no page open, left
  // the erased wallet's flags and display preferences in localStorage; an
  // earlier build, its send form too.
  describe('the wallet data in localStorage', () => {
    const DRAFT = 'qb1zdraftoftheerasedwallet';
    const SAVED_UI_KEY = 'redux_localstorage_simple_ui';
    // The display preferences the wallet's windows saved, and the initial ones.
    const PREFERENCES = { isBalanceHidden: true, balanceDetailExpanded: false };
    const INITIAL_PREFERENCES = { isBalanceHidden: false, balanceDetailExpanded: true };
    const savedPreferences = () => JSON.parse(localStorage.getItem(SAVED_UI_KEY) ?? 'null') as unknown;
    const noDraftSaved = () => expect(Object.values({ ...localStorage }).join('\n')).not.toContain(DRAFT);

    // The keys as the erased wallet's windows left them, owned by `owner`:
    // the saved ui state holds the display preferences alone.
    function leftInStorage(owner: string | null) {
      if (owner !== null) localStorage.setItem(WALLET_DATA_OWNER_KEY, owner);
      localStorage.setItem(SAVED_UI_KEY, JSON.stringify(PREFERENCES));
      localStorage.setItem('ecosystem_warning_acknowledged', 'true');
      localStorage.setItem('mine_tab_seen', 'true');
      localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.9', isShow: false }));
      localStorage.setItem('i18nextLng', 'ja');
    }

    // The page opens on what storage holds: its store loads the saved
    // display preferences, and nothing of a send form.
    function openPageOnStorage(wallet: Background) {
      const opened = openPage(wallet);
      expect(opened.store.getState().ui).toMatchObject(PREFERENCES);
      expect(opened.store.getState().ui.uiTxCreateScreen.toInfo.address).toBe('');
      return opened;
    }

    const keys = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).sort();

    // A page that starts as nothing is booted, as the Welcome screen.
    function nothingBooted(wallet: Background) {
      wallet.getWalletId.mockResolvedValue(null);
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.hasVault.mockResolvedValue(false);
      return wallet;
    }

    // The page closes, and another opens on what storage holds.
    function reopenPage(wallet: Background) {
      cleanup();
      forgetShownWalletId();
      forgetWalletDataOwnerAtLoad();
      noteWalletDataOwnerAtLoad();
      return openPage(wallet);
    }

    // The review's sequence: a window that missed the reset (its port was
    // down) still writes the erased wallet's preferences and flags after it.
    it('leaves nothing of the erased wallet to the next one, whatever a window that missed the reset wrote after it', async () => {
      leftInStorage('wallet-erased');
      // The reset, in a window that heard of it.
      createWalletResetHandler({ clearMemory: vi.fn(), reload: vi.fn() }).onWalletReset();
      // The stale window saves its display preferences, and acknowledges a notice.
      leftInStorage(null);
      noteWalletDataOwnerAtLoad();
      const wallet = nothingBooted(background());

      // A Welcome page starts on what storage holds.
      const { store } = openPageOnStorage(wallet);
      await settle();
      expect(keys()).toEqual(['i18nextLng', WALLET_DATA_OWNER_KEY].sort());
      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe(WALLET_DATA_RESET_MARK);
      expect(store.getState().ui).toMatchObject(INITIAL_PREFERENCES);

      // The stale window writes again; then the new wallet is made on this page.
      localStorage.setItem('ecosystem_warning_acknowledged', 'true');
      wallet.getWalletId.mockResolvedValue('wallet-new');
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true }));
      });
      await settle();
      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-new');

      // The next page start, with the new wallet booted.
      const next = background();
      next.getWalletId.mockResolvedValue('wallet-new');
      const reopened = reopenPage(next);
      await settle();

      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-new');
      for (const flag of ['ecosystem_warning_acknowledged', 'mine_tab_seen', 'version_detail']) {
        expect(localStorage.getItem(flag), flag).toBeNull();
      }
      // Nothing saved, or the initial preferences a save put back.
      expect([null, INITIAL_PREFERENCES]).toContainEqual(savedPreferences());
      expect(reopened.store.getState().ui).toMatchObject(INITIAL_PREFERENCES);
      expect(localStorage.getItem('i18nextLng')).toBe('ja');
    });

    it('is removed at the next start, and the new wallet starts clean', async () => {
      leftInStorage('wallet-erased');
      noteWalletDataOwnerAtLoad();
      const wallet = background();
      // Nothing booted yet: the reset is done, the new wallet still to come.
      wallet.getWalletId.mockResolvedValue(null);
      wallet.getCurrentAccount.mockResolvedValue(null);
      wallet.hasVault.mockResolvedValue(false);
      const { store } = openPageOnStorage(wallet);

      await settle();

      expect(keys()).toEqual(['i18nextLng', WALLET_DATA_OWNER_KEY].sort());
      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe(WALLET_DATA_RESET_MARK);
      expect(store.getState().ui).toMatchObject(INITIAL_PREFERENCES);
      // A second later, a save puts back only the initial preferences.
      await settle(1_100);
      expect(savedPreferences()).toEqual(INITIAL_PREFERENCES);

      // The new wallet is made here, and is recorded as the owner; what it
      // writes from then on is its own.
      wallet.getWalletId.mockResolvedValue('wallet-new');
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true }));
      });
      await settle();
      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-new');
      localStorage.setItem('mine_tab_seen', 'true');
      const next = background();
      next.getWalletId.mockResolvedValue('wallet-new');
      reopenPage(next);
      await settle();
      expect(localStorage.getItem('mine_tab_seen')).toBe('true');
    });

    it('is removed when another wallet is booted, which is recorded as its owner', async () => {
      leftInStorage('wallet-erased');
      noteWalletDataOwnerAtLoad();
      const wallet = background();
      const { store } = openPageOnStorage(wallet);

      await settle();

      expect(keys()).toEqual(['i18nextLng', WALLET_DATA_OWNER_KEY].sort());
      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-1');
      expect(store.getState().ui).toMatchObject(INITIAL_PREFERENCES);
    });

    // An earlier build saved the whole ui state, the send form included. The
    // store keeps only the preferences of it, and rewrites the saved value
    // to them as it loads, before the page notes their owner: nothing of the
    // form comes back, and the erased wallet's preferences go at the start.
    it('is removed when an earlier build saved it, its send form never loaded', async () => {
      leftInStorage('wallet-erased');
      localStorage.setItem(
        SAVED_UI_KEY,
        JSON.stringify({
          ...createAppStore().getState().ui,
          ...PREFERENCES,
          uiTxCreateScreen: { ...createAppStore().getState().ui.uiTxCreateScreen, toInfo: { address: DRAFT } }
        })
      );
      localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-erased');
      const { store } = openPageOnStorage(background());
      noteWalletDataOwnerAtLoad();
      expect(savedPreferences()).toEqual(PREFERENCES);
      noDraftSaved();

      await settle();

      expect(keys()).toEqual(['i18nextLng', WALLET_DATA_OWNER_KEY].sort());
      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-1');
      expect(store.getState().ui).toMatchObject(INITIAL_PREFERENCES);
      expect(store.getState().ui.uiTxCreateScreen.toInfo.address).toBe('');
    });

    it('stays when it belongs to the wallet booted', async () => {
      leftInStorage('wallet-1');
      noteWalletDataOwnerAtLoad();
      const { store } = openPageOnStorage(background());

      await settle();

      expect(localStorage.getItem('mine_tab_seen')).toBe('true');
      expect(localStorage.getItem('ecosystem_warning_acknowledged')).toBe('true');
      expect(store.getState().ui).toMatchObject(PREFERENCES);
    });

    it('stays, and gets the wallet booted as its owner, on the first start that records one', async () => {
      leftInStorage(null);
      noteWalletDataOwnerAtLoad();
      const { store } = openPageOnStorage(background());

      await settle();

      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-1');
      expect(localStorage.getItem('mine_tab_seen')).toBe('true');
      expect(store.getState().ui).toMatchObject(PREFERENCES);
    });

    it('stays, with nothing recorded, on the first start of an install from before the owner key with nothing booted', async () => {
      leftInStorage(null);
      noteWalletDataOwnerAtLoad();
      const { store } = openPageOnStorage(nothingBooted(background()));

      await settle();

      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBeNull();
      expect(localStorage.getItem('mine_tab_seen')).toBe('true');
      expect(store.getState().ui).toMatchObject(PREFERENCES);
    });

    it('stays with the wallet in use: its first start after this change, a lock and unlock, a second window, a restart', async () => {
      const kept = () => {
        expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-1');
        expect(localStorage.getItem('mine_tab_seen')).toBe('true');
        expect(localStorage.getItem('ecosystem_warning_acknowledged')).toBe('true');
        expect(localStorage.getItem('version_detail')).toContain('1.0.9');
        expect(savedPreferences()).toEqual(PREFERENCES);
      };
      leftInStorage(null);
      noteWalletDataOwnerAtLoad();
      const first = openPageOnStorage(background());
      await settle();
      kept();

      act(() => {
        first.store.dispatch(globalActions.update({ isUnlocked: false }));
      });
      act(() => {
        first.store.dispatch(globalActions.update({ isUnlocked: true }));
      });
      await settle(1_100);
      kept();

      // A second window opens beside it.
      forgetWalletDataOwnerAtLoad();
      noteWalletDataOwnerAtLoad();
      const second = openPageOnStorage(background());
      await settle(1_100);
      kept();
      expect(second.store.getState().ui).toMatchObject(PREFERENCES);

      // Both close, and a page opens again later.
      const restarted = reopenPage(background());
      await settle(1_100);
      kept();
      expect(restarted.store.getState().ui).toMatchObject(PREFERENCES);
    });

    it('stays when the id cannot be read', async () => {
      leftInStorage('wallet-erased');
      noteWalletDataOwnerAtLoad();
      const wallet = background();
      wallet.getWalletId.mockRejectedValue({ message: 'QUOTA_BYTES quota exceeded' });
      const { store } = openPageOnStorage(wallet);

      await settle();

      expect(showsWalletPages()).toBe(true);
      expect(localStorage.getItem(WALLET_DATA_OWNER_KEY)).toBe('wallet-erased');
      expect(localStorage.getItem('mine_tab_seen')).toBe('true');
      expect(store.getState().ui).toMatchObject(PREFERENCES);
    });
  });
});
