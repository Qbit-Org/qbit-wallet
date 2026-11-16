import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChainType } from '@qbit/wallet-types';
import { ErrorCodes } from '@qbit/wallet-shared';
import { createAppStore, globalActions, WalletProvider } from '@qbit/wallet-state';

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
  WALLET_ID_MISSING_REOPEN_KEY,
  waitForShownWalletId
} from '../src/ui/utils/walletReset';
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
    expect(showsSpinner(page)).toBe(true);

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

    function openGuardedPage<T extends Record<string, unknown>>(wallet: T) {
      const store = createAppStore();
      const reached: Reached[] = [];
      const refusals: unknown[] = [];
      const rule = {
        walletId: getShownWalletId,
        showsWalletContent: () => pageShowsWalletContent(store.getState()),
        waitForWalletId: () => waitForShownWalletId(),
        refuseWithoutWalletId: () => {
          const refusal = refuseWithoutWalletId('wallet_page_out_of_date');
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
      render(
        <Provider store={store}>
          <WalletProvider wallet={guarded as unknown as Parameters<typeof WalletProvider>[0]['wallet']}>
            <PageStartup>
              <span data-testid="wallet-pages" />
            </PageStartup>
          </WalletProvider>
        </Provider>
      );
      return { store, guarded, reached, refusals };
    }

    // A background with the calls the screens below make.
    const backgroundWithScreens = () =>
      Object.assign(background(), {
        createKeyringWithMnemonics: vi.fn(async () => undefined),
        getAddressBalanceV2: vi.fn(async () => ({ totalBalance: 0 })),
        addContact: vi.fn(async () => true),
        unlock: vi.fn(async () => undefined)
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
      // Its first screens ask for the balance as soon as the account shows,
      // before the run that loaded it records the id.
      let balance: Promise<unknown> | undefined;
      let idWhenShown: string | undefined = 'not shown';
      const unsubscribe = store.subscribe(() => {
        if (balance === undefined && store.getState().accounts.current.address === account.address) {
          idWhenShown = getShownWalletId();
          balance = guarded.getAddressBalanceV2(account.address);
        }
      });
      // As the create hook marks it.
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: true, isBooted: true }));
      });
      await settle();
      unsubscribe();

      expect(idWhenShown).toBeUndefined();
      await expect(balance).resolves.toEqual({ totalBalance: 0 });
      expect(getShownWalletId()).toBe('wallet-new');
      expect(reached.filter((call) => call.method === 'getAddressBalanceV2')).toEqual([
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
      const wallet = backgroundWithScreens();
      wallet.isUnlocked.mockResolvedValue(true);
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      const { store, guarded, reached } = openGuardedPage(wallet);
      await settle();
      expect(pageShowsWalletContent(store.getState())).toBe(true);
      expect(getShownWalletId()).toBeUndefined();

      const adding = guarded.addContact({ address: 'qb1zfriend', name: 'Friend' }).then(
        () => 'sent',
        (error: unknown) => error
      );
      await settle();

      expect(await adding).toMatchObject({ code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE });
      expect(wallet.addContact).not.toHaveBeenCalled();
      expect(reached.map((call) => call.method)).not.toContain('addContact');
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    });

    it('holds a call made while the retry reads the id, and sends it with the id once recorded', async () => {
      const wallet = backgroundWithScreens();
      wallet.isUnlocked.mockResolvedValue(true);
      wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
      const { guarded, reached } = openGuardedPage(wallet);
      await settle();
      // The retry's read, held while the call comes.
      let answerRetry: ((id: string) => void) | undefined;
      wallet.getWalletId.mockImplementation(() => new Promise<string>((resolve) => (answerRetry = resolve)));
      await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
      expect(answerRetry).toBeTypeOf('function');

      const adding = guarded.addContact({ address: 'qb1zfriend', name: 'Friend' });
      await settle();
      expect(wallet.addContact).not.toHaveBeenCalled();
      await act(async () => {
        answerRetry?.('wallet-1');
      });
      await settle();

      await expect(adding).resolves.toBe(true);
      expect(reached.filter((call) => call.method === 'addContact')).toEqual([
        { method: 'addContact', walletId: 'wallet-1' }
      ]);
      expect(reloadOnBoot).not.toHaveBeenCalled();
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
    // failing. Neither a reconnection nor an unlock takes it for up to date.
    describe('locked, showing an account, without an id', () => {
      const bus = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
      const reloadOnBoot = vi.fn();
      let uninstall: () => void;
      const contentOf = (store: ReturnType<typeof createAppStore>) => () => pageShowsWalletContent(store.getState());

      async function lockedWithoutAnId() {
        const wallet = Object.assign(background(), { isBooted: vi.fn(async () => true) });
        wallet.isUnlocked.mockResolvedValue(true);
        wallet.getWalletId.mockRejectedValue(SAVE_FAILED);
        const { store } = openPage(wallet);
        await settle();
        act(() => {
          store.dispatch(globalActions.update({ isUnlocked: false }));
        });
        await settle();
        expect(getShownWalletId()).toBeUndefined();
        expect(store.getState().accounts.current.address).toBe(account.address);
        const reads = { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() };
        return { wallet, store, reads };
      }

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

      it('reopens at a reconnection', async () => {
        const { store, reads } = await lockedWithoutAnId();

        createReconnectReconcile({
          holdsWallet: () => true,
          shownWalletId: getShownWalletId,
          showsWalletContent: contentOf(store),
          wallet: reads,
          waitForStartup: async () => true
        })();
        await settle();

        expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      });

      it('reopens at an unlock, which does not go on', async () => {
        const { store, reads } = await lockedWithoutAnId();
        const gate = createUnlockGate({
          holdsWallet: () => true,
          shownWalletId: getShownWalletId,
          showsWalletContent: contentOf(store),
          isStarted: () => store.getState().global.isReady,
          isUnlocked: () => store.getState().global.isUnlocked,
          wallet: reads,
          onUnknown: vi.fn(),
          refusal: () => 'wallet_page_out_of_date'
        });

        let passed: boolean | undefined;
        await act(async () => {
          passed = await gate.beforeUnlockedBroadcast();
        });

        expect(passed).toBe(false);
        expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      });

      it('compares nothing once it has dropped what it showed and recorded the id', async () => {
        const { wallet, store, reads } = await lockedWithoutAnId();
        wallet.getWalletId.mockResolvedValue('wallet-1');
        await settle(PAGE_WALLET_ID_RETRY_DELAYS_MS[0]);
        expect(getShownWalletId()).toBe('wallet-1');
        expect(contentOf(store)()).toBe(false);

        createReconnectReconcile({
          holdsWallet: () => true,
          shownWalletId: getShownWalletId,
          showsWalletContent: contentOf(store),
          wallet: reads,
          waitForStartup: async () => true
        })();
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
      const { store, page } = openPage(wallet);

      await settle();
      expect(store.getState().global.isReady).toBe(false);
      expect(showsSpinner(page)).toBe(true);
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

      // A later run, which the lock starts, can read it.
      wallet.getWalletId.mockResolvedValue('wallet-1');
      act(() => {
        store.dispatch(globalActions.update({ isUnlocked: false }));
      });
      await settle();
      expect(getShownWalletId()).toBe('wallet-1');
      expect(store.getState().accounts.current.address).toBe('');
      expect(store.getState().accounts.accounts).toEqual([]);
      expect(store.getState().keyrings.keyrings).toEqual([]);
      const idRead = wallet.getWalletId.mock.invocationCallOrder.at(-1) ?? Infinity;

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
