import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUS_METHODS, ErrorCodes, THEME_MODE_STORAGE_KEY } from '@qbit/wallet-shared';

import {
  checkShownWallet,
  claimReopenWithoutId,
  clearWalletLocalStorage,
  createReconnectReconcile,
  createUnlockGate,
  createWalletResetHandler,
  forgetShownWalletId,
  forgetWalletDataOwnerAtLoad,
  getShownWalletId,
  installPageWalletResetHandler,
  installWalletResetHandler,
  isShownWalletGoneError,
  KEPT_LOCAL_STORAGE_KEYS,
  noteWalletDataOwnerAtLoad,
  reconcileStoredWalletData,
  reconcileWalletDataKeys,
  reconcileWalletReset,
  recordShownWalletId,
  reloadOnBootRoute,
  reloadOnWelcome,
  reopenOutOfDatePage,
  requestWalletReset,
  takeWalletResetNotice,
  UNLOCK_REOPEN_WAIT_MS,
  WALLET_RESET_ANSWER_WAIT_MS,
  WALLET_RESET_LANDING_HASH,
  WALLET_RESET_NOTICE_KEY,
  WALLET_DATA_OWNER_KEY,
  WALLET_DATA_RESET_MARK,
  WALLET_ID_MISSING_REOPEN_KEY,
  WALLET_REPLACED_LANDING_HASH,
  type WalletResetHandler
} from './walletReset';

const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, listener: () => void) => {
      const forType = listeners.get(type) ?? new Set<() => void>();
      forType.add(listener);
      listeners.set(type, forType);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    }
  };
});

vi.mock('@qbit/wallet-state', () => ({
  resetWalletState: () => ({ type: 'global/resetWalletState' }),
  uiEventBus: bus
}));

const SAVED_UI_KEY = 'redux_localstorage_simple_ui';

// Everything a window has in localStorage while a wallet exists.
function seedLocalStorage() {
  // The saved ui state: the display preferences alone; no send form is saved.
  localStorage.setItem(SAVED_UI_KEY, JSON.stringify({ isBalanceHidden: true, balanceDetailExpanded: false }));
  localStorage.setItem('ecosystem_warning_acknowledged', 'true');
  localStorage.setItem('mine_tab_seen', 'true');
  localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.9' }));
  localStorage.setItem('i18nextLng', 'ja');
  localStorage.setItem('userSelectedLanguage', 'true');
  localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark');
  localStorage.setItem('a_flag_added_later', '1');
}

const keptOnly = () => ({
  i18nextLng: 'ja',
  userSelectedLanguage: 'true',
  [THEME_MODE_STORAGE_KEY]: 'dark'
});
// What a reset leaves: the language, the theme, and the owner key marked.
const afterReset = () => ({ ...keptOnly(), [WALLET_DATA_OWNER_KEY]: WALLET_DATA_RESET_MARK });
const storageContents = () =>
  Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) as string).map((key) => [
      key,
      localStorage.getItem(key)
    ])
  );

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('the page WALLET_RESET handler', () => {
  const reload = vi.fn();
  // The saved `ui` slice as it was each time the store dropped its state.
  const savedUiWhenMemoryCleared: (string | null)[] = [];
  const clearMemory = vi.fn(() => {
    savedUiWhenMemoryCleared.push(localStorage.getItem(SAVED_UI_KEY));
  });
  const handler = () => createWalletResetHandler({ clearMemory, reload });

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    reload.mockReset();
    clearMemory.mockClear();
    savedUiWhenMemoryCleared.length = 0;
    seedLocalStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps only the language and the theme in localStorage, and marks its owner key as reset', () => {
    expect([...KEPT_LOCAL_STORAGE_KEYS].sort()).toEqual(
      ['i18nextLng', THEME_MODE_STORAGE_KEY, 'userSelectedLanguage'].sort()
    );

    clearWalletLocalStorage(localStorage);

    expect(storageContents()).toEqual(afterReset());
  });

  it('drops the state in memory before the saved copy, then reopens the window on Welcome', () => {
    handler().onWalletReset();

    expect(clearMemory).toHaveBeenCalled();
    // Memory went first: a save still due finds nothing left to write back.
    expect(savedUiWhenMemoryCleared[0]).not.toBeNull();
    expect(storageContents()).toEqual(afterReset());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('changes nothing further on a second WALLET_RESET', () => {
    const reset = handler();
    reset.onWalletReset();
    const cleared = clearMemory.mock.calls.length;
    localStorage.setItem('written_meanwhile', 'x');

    reset.onWalletReset();

    expect(clearMemory).toHaveBeenCalledTimes(cleared);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('written_meanwhile')).toBe('x');
  });

  it('drops the memory of a replaced wallet, keeps localStorage, and reopens on the boot route, once', () => {
    const reloadOnBoot = vi.fn();
    const reset = createWalletResetHandler({ clearMemory, reload, reloadOnBoot });
    // The owner as a window of the wallet set up now recorded it: it stays.
    localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-b');
    const before = storageContents();

    reset.onWalletReplaced();

    expect(clearMemory).toHaveBeenCalledTimes(1);
    // The saved ui state holds no send form, only display preferences that
    // the windows of the wallet set up now may have saved: it stays.
    expect(storageContents()).toEqual(before);
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    reset.onWalletReplaced();
    reset.onWalletReset();
    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  describe('a replaced wallet seen while a reset request of this window is out', () => {
    const reloadOnBoot = vi.fn();
    const handlerWithBoot = () => createWalletResetHandler({ clearMemory, reload, reloadOnBoot });

    beforeEach(() => {
      reloadOnBoot.mockReset();
    });

    it('reopens on the boot route only once the request is refused', async () => {
      const reset = handlerWithBoot();
      const answer = deferred<void>();
      const request = reset.request(() => answer.promise);

      reset.onWalletReplaced();
      expect(clearMemory).not.toHaveBeenCalled();
      expect(reloadOnBoot).not.toHaveBeenCalled();

      answer.reject(new Error('Password is incorrect'));
      await expect(request).rejects.toThrow('Password is incorrect');
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      expect(clearMemory).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    });

    it('lands on Welcome instead when the request erased the wallets', async () => {
      const reset = handlerWithBoot();
      const answer = deferred<void>();
      const request = reset.request(() => answer.promise);

      reset.onWalletReplaced();
      answer.resolve();
      await request;

      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadOnBoot).not.toHaveBeenCalled();
      expect(storageContents()).toEqual(afterReset());
    });

    it('lands on Welcome when WALLET_RESET comes meanwhile, whatever the request answers', async () => {
      const reset = handlerWithBoot();
      const answer = deferred<void>();
      const request = reset.request(() => answer.promise);

      reset.onWalletReplaced();
      reset.onWalletReset();
      answer.reject(new Error('The connection to Qbit Wallet closed'));
      await expect(request).rejects.toThrow();

      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    it('stops waiting for an answer that never comes', () => {
      vi.useFakeTimers();
      const reset = handlerWithBoot();
      void reset.request(() => new Promise<void>(() => undefined));

      reset.onWalletReplaced();
      vi.advanceTimersByTime(WALLET_RESET_ANSWER_WAIT_MS - 1);
      expect(reloadOnBoot).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    });
  });

  it('holds the reload of the window that asked until its reset answers', async () => {
    const reset = handler();
    const answer = deferred<void>();
    const request = reset.request(() => answer.promise);

    // The background tells every window, this one too, before it answers.
    reset.onWalletReset();
    expect(clearMemory).toHaveBeenCalled();
    expect(storageContents()).toEqual(afterReset());
    expect(reload).not.toHaveBeenCalled();

    // Written while the answer was on its way: cleared again on the way out.
    localStorage.setItem(SAVED_UI_KEY, '{"late":true}');
    answer.resolve();
    await request;

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storageContents()).toEqual(afterReset());
  });

  it('carries an incomplete reset across the reload, to be shown once', async () => {
    const reset = handler();
    const answer = deferred<void>();
    const request = reset.request(() => answer.promise);
    reset.onWalletReset();
    const incomplete = { code: ErrorCodes.WALLET_RESET_INCOMPLETE, message: 'wallet_reset_incomplete' };

    answer.reject(incomplete);

    await expect(request).rejects.toBe(incomplete);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(WALLET_RESET_NOTICE_KEY)).toBe('incomplete');
    expect(takeWalletResetNotice()).toBe(true);
    expect(takeWalletResetNotice()).toBe(false);
  });

  it('reloads on an incomplete reset that answers before the event', async () => {
    const reset = handler();
    const incomplete = { code: ErrorCodes.WALLET_RESET_INCOMPLETE };

    await expect(reset.request(() => Promise.reject(incomplete))).rejects.toBe(incomplete);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storageContents()).toEqual(afterReset());
    reset.onWalletReset();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on a success that answers before the event, and only once', async () => {
    const reset = handler();

    await reset.request(() => Promise.resolve());
    reset.onWalletReset();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storageContents()).toEqual(afterReset());
  });

  it('erases and reloads nothing for a refusal that erased nothing', async () => {
    const reset = handler();
    const refusal = { message: 'Password is incorrect' };

    await expect(reset.request(() => Promise.reject(refusal))).rejects.toBe(refusal);

    expect(clearMemory).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAVED_UI_KEY)).not.toBeNull();
    expect(sessionStorage.getItem(WALLET_RESET_NOTICE_KEY)).toBeNull();
  });

  it('still reloads when the event came and the answer is a refusal', async () => {
    const reset = handler();
    const answer = deferred<void>();
    const request = reset.request(() => answer.promise);
    reset.onWalletReset();

    answer.reject({ message: 'wallet is locked' });
    await request.catch(() => undefined);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for an answer that never comes', () => {
    vi.useFakeTimers();
    const reset = handler();
    void reset.request(() => new Promise<void>(() => undefined));
    reset.onWalletReset();

    vi.advanceTimersByTime(WALLET_RESET_ANSWER_WAIT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storageContents()).toEqual(afterReset());
  });

  it('still reloads where storage is denied', async () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const reset = createWalletResetHandler({ clearMemory, reload, localStorage: denied, sessionStorage: denied });

    await expect(reset.request(() => Promise.reject({ code: ErrorCodes.WALLET_RESET_INCOMPLETE }))).rejects.toEqual({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE
    });

    expect(clearMemory).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(takeWalletResetNotice(denied)).toBe(false);
  });
});

// After a refusal other than -11 and -19, whose request may have been lost.
describe('reconciling a refused reset', () => {
  const reload = vi.fn();
  const clearMemory = vi.fn();
  let uninstall: () => void;

  beforeEach(() => {
    reload.mockReset();
    clearMemory.mockReset();
    localStorage.clear();
    seedLocalStorage();
    uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload }), bus);
  });

  afterEach(() => {
    uninstall();
    localStorage.clear();
  });

  it('treats a background with no wallet set up as erased, and handles it as WALLET_RESET', async () => {
    await expect(reconcileWalletReset(() => Promise.resolve(false))).resolves.toBe('erased');

    expect(clearMemory).toHaveBeenCalled();
    expect(storageContents()).toEqual(afterReset());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps everything when the background still has its wallets', async () => {
    await expect(reconcileWalletReset(() => Promise.resolve(true))).resolves.toBe('kept');

    expect(clearMemory).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAVED_UI_KEY)).not.toBeNull();
  });

  it.each([
    ['fails too', () => Promise.reject({ code: 4900 })],
    [
      'throws at once',
      () => {
        throw new Error('port gone');
      }
    ],
    ['answers no boolean', () => Promise.resolve(undefined)],
    ['answers a truthy string', () => Promise.resolve('false')]
  ])('cannot tell, and changes nothing, when the question %s', async (_name, isBooted) => {
    await expect(reconcileWalletReset(isBooted as () => Promise<unknown>)).resolves.toBe('unknown');

    expect(clearMemory).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

// After the page's connection to the background came back (watchPortReconnects).
describe('checking, by its id, the wallet a page shows after a reconnection', () => {
  const reload = vi.fn();
  const reloadOnBoot = vi.fn();
  const clearMemory = vi.fn();
  let uninstall: () => void;

  // The background, booted with the wallet `id` names.
  function background({ booted = true as unknown, id = 'wallet-a' as unknown } = {}) {
    const state = { booted, id };
    return {
      state,
      isBooted: vi.fn(async (): Promise<unknown> => state.booted),
      getWalletId: vi.fn(async (): Promise<unknown> => state.id)
    };
  }

  // The background answers at once: no wait for its start-up is needed.
  const started = vi.fn(async () => true);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // `shownId` null stands for a page that recorded no id; `content`, for one
  // that shows an account or the wallets.
  function reconcile(
    wallet: ReturnType<typeof background>,
    {
      shownId = 'wallet-a',
      holdsWallet = () => true,
      content = false,
      waitForStartup = started
    }: {
      shownId?: string | null;
      holdsWallet?: () => boolean;
      content?: boolean;
      waitForStartup?: () => Promise<boolean>;
    } = {}
  ) {
    return createReconnectReconcile({
      holdsWallet,
      shownWalletId: () => shownId ?? undefined,
      showsWalletContent: () => content,
      wallet,
      waitForStartup
    });
  }

  beforeEach(() => {
    reload.mockReset();
    reloadOnBoot.mockReset();
    clearMemory.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    seedLocalStorage();
    uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload, reloadOnBoot }), bus);
  });

  afterEach(() => {
    uninstall();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('reopens on the boot route when the background holds another wallet, keeping the rest of localStorage', async () => {
    // A reset this page missed, then a wallet made in another window.
    const wallet = background({ id: 'wallet-b' });
    localStorage.setItem('written_by_the_new_wallet', '1');

    reconcile(wallet)();

    await vi.waitFor(() => expect(reloadOnBoot).toHaveBeenCalledTimes(1));
    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SAVED_UI_KEY)).toBe('{"isBalanceHidden":true,"balanceDetailExpanded":false}');
    expect(localStorage.getItem('written_by_the_new_wallet')).toBe('1');
    expect(localStorage.getItem('ecosystem_warning_acknowledged')).toBe('true');
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
    expect(localStorage.getItem('version_detail')).not.toBeNull();
    expect(localStorage.getItem('a_flag_added_later')).toBe('1');
    expect(reload).not.toHaveBeenCalled();
  });

  it('changes nothing when the background holds the wallet the page shows', async () => {
    const wallet = background();

    reconcile(wallet)();
    await vi.waitFor(() => expect(wallet.getWalletId).toHaveBeenCalledTimes(1));
    await settle();

    expect(clearMemory).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it('lands on Welcome as before when nothing is booted', async () => {
    const wallet = background({ booted: false, id: null });

    reconcile(wallet)();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(clearMemory).toHaveBeenCalled();
    expect(storageContents()).toEqual(afterReset());
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('sends both questions at once, as it is called', () => {
    const wallet = background();

    reconcile(wallet)();

    expect(wallet.isBooted).toHaveBeenCalledTimes(1);
    expect(wallet.getWalletId).toHaveBeenCalledTimes(1);
  });

  it('compares nothing for a page that holds no id and shows no wallet content, and lands on Welcome as before when nothing is booted', async () => {
    const wallet = background({ id: 'wallet-b' });
    reconcile(wallet, { shownId: null })();
    await vi.waitFor(() => expect(wallet.isBooted).toHaveBeenCalledTimes(1));
    await settle();
    expect(wallet.getWalletId).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();

    wallet.state.booted = false;
    reconcile(wallet, { shownId: null })();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  // An id read that kept failing, as when the first save of a new id fails:
  // what the page shows cannot be told from another wallet's.
  it('reopens on the boot route, once, a page that shows wallet content but holds no id', async () => {
    const wallet = background({ id: 'wallet-b' });
    const check = reconcile(wallet, { shownId: null, content: true });

    check();
    await vi.waitFor(() => expect(reloadOnBoot).toHaveBeenCalledTimes(1));
    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(wallet.getWalletId).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBe('1');

    // The next reconnection of the same page changes nothing more.
    check();
    await vi.waitFor(() => expect(wallet.isBooted).toHaveBeenCalledTimes(2));
    await settle();
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(clearMemory).toHaveBeenCalledTimes(1);
  });

  it('stays as it is, once reopened for that, while it still holds no id', async () => {
    // The page reopened in this window, and its id read fails again.
    sessionStorage.setItem(WALLET_ID_MISSING_REOPEN_KEY, '1');
    const wallet = background({ id: 'wallet-b' });

    reconcile(wallet, { shownId: null, content: true })();
    await vi.waitFor(() => expect(wallet.isBooted).toHaveBeenCalledTimes(1));
    await settle();

    expect(reloadOnBoot).not.toHaveBeenCalled();
    expect(clearMemory).not.toHaveBeenCalled();
  });

  it('asks nothing on a page that holds no wallet, such as the first-run page before its first wallet', async () => {
    const wallet = background({ id: 'wallet-b' });

    reconcile(wallet, { holdsWallet: () => false })();
    await settle();

    expect(wallet.isBooted).not.toHaveBeenCalled();
    expect(wallet.getWalletId).not.toHaveBeenCalled();
  });

  it('asks once at a time, and again on a later reconnection', async () => {
    const wallet = background();
    const answer = deferred<unknown>();
    wallet.isBooted.mockReturnValueOnce(answer.promise);
    const onReconnect = reconcile(wallet);

    onReconnect();
    onReconnect();
    expect(wallet.isBooted).toHaveBeenCalledTimes(1);
    answer.resolve(true);
    await vi.waitFor(() => {
      onReconnect();
      expect(wallet.isBooted).toHaveBeenCalledTimes(2);
    });
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a refused id',
      {
        getWalletId: () =>
          Promise.reject({ message: 'Qbit Wallet was reset before this request ran, so it did not run' })
      }
    ],
    ['a null id from a booted background', { getWalletId: () => Promise.resolve(null) }],
    ['no boolean for isBooted', { isBooted: () => Promise.resolve(undefined) }],
    ['a failed isBooted', { isBooted: () => Promise.reject(new Error('port gone')) }]
  ])('changes nothing on %s, and asks again once start-up is done', async (_name, answers) => {
    const wallet = background({ id: 'wallet-b' });
    if ('getWalletId' in answers) wallet.getWalletId.mockImplementationOnce(answers.getWalletId);
    if ('isBooted' in answers) wallet.isBooted.mockImplementationOnce(answers.isBooted);
    const ready = deferred<boolean>();
    const waitForStartup = vi.fn(() => ready.promise);

    reconcile(wallet, { waitForStartup })();
    await vi.waitFor(() => expect(waitForStartup).toHaveBeenCalledTimes(1));
    expect(clearMemory).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();

    // Asked again once start-up is done: the background holds another wallet.
    ready.resolve(true);
    await vi.waitFor(() => expect(reloadOnBoot).toHaveBeenCalledTimes(1));
    expect(wallet.isBooted).toHaveBeenCalledTimes(2);
  });

  describe('while the background is still starting', () => {
    const notLoaded = () => Promise.reject(new TypeError('Cannot read properties of undefined (reading getState)'));

    it('lands on Welcome when the second answer is that nothing is booted', async () => {
      const wallet = background({ booted: false, id: null });
      wallet.isBooted.mockImplementationOnce(notLoaded);
      reconcile(wallet)();

      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(wallet.isBooted).toHaveBeenCalledTimes(2);
    });

    it('changes nothing when the second answer is the same wallet', async () => {
      const wallet = background();
      wallet.isBooted.mockImplementationOnce(notLoaded);
      reconcile(wallet)();

      await vi.waitFor(() => expect(wallet.isBooted).toHaveBeenCalledTimes(2));
      await settle();
      expect(clearMemory).not.toHaveBeenCalled();
      expect(reloadOnBoot).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it('asks no more and changes nothing when start-up never finishes', async () => {
      const wallet = background({ id: 'wallet-b' });
      wallet.isBooted.mockImplementation(notLoaded);
      const waitForStartup = vi.fn(async () => false);
      reconcile(wallet, { waitForStartup })();

      await vi.waitFor(() => expect(waitForStartup).toHaveBeenCalledTimes(1));
      await settle();
      expect(wallet.isBooted).toHaveBeenCalledTimes(1);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    it('asks no more for a page that dropped its wallet meanwhile', async () => {
      const wallet = background({ id: 'wallet-b' });
      wallet.isBooted.mockImplementation(notLoaded);
      let holds = true;
      const waitForStartup = vi.fn(async () => {
        holds = false;
        return true;
      });
      reconcile(wallet, { holdsWallet: () => holds, waitForStartup })();

      await vi.waitFor(() => expect(waitForStartup).toHaveBeenCalledTimes(1));
      await settle();
      expect(wallet.isBooted).toHaveBeenCalledTimes(1);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });
  });
});

// An unlock answers, and the background's UNLOCKED reaches the page, only once
// this has settled (createWalletProxy's afterUnlock, setupEventBusListeners).
describe('checking, by its id, the wallet a page shows at an unlock', () => {
  const reload = vi.fn();
  const reloadOnBoot = vi.fn();
  const clearMemory = vi.fn();
  const onUnknown = vi.fn();
  let uninstall: (() => void) | undefined;
  const REFUSAL = 'The selected wallet is no longer available';

  function unlockGate(
    answers: { isBooted?: () => Promise<unknown>; getWalletId?: () => Promise<unknown> },
    { shownId = 'wallet-a' as string | null, started = true, unlocked = false, content = false } = {}
  ) {
    const wallet = {
      isBooted: vi.fn(answers.isBooted ?? (async () => true)),
      getWalletId: vi.fn(answers.getWalletId ?? (async () => 'wallet-a'))
    };
    const gate = createUnlockGate({
      holdsWallet: () => true,
      shownWalletId: () => shownId ?? undefined,
      showsWalletContent: () => content,
      isStarted: () => started,
      isUnlocked: () => unlocked,
      wallet,
      onUnknown,
      refusal: () => REFUSAL
    });
    return { gate, wallet };
  }
  // How `promise` stands once everything due has run.
  async function state(promise: Promise<unknown>) {
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    let error: unknown;
    void promise.then(
      () => (outcome = 'resolved'),
      (failure: unknown) => {
        outcome = 'rejected';
        error = failure;
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    return { outcome, error };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    reload.mockReset();
    reloadOnBoot.mockReset();
    clearMemory.mockReset();
    onUnknown.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    seedLocalStorage();
    uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload, reloadOnBoot }), bus);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('for its own unlock request', () => {
    it('lets the unlock go on when the id is the one the page shows', async () => {
      const { gate } = unlockGate({});
      expect((await state(gate.afterUnlock())).outcome).toBe('resolved');
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    it('reopens on the boot route when the id differs, and ends the unlock refused if the page is still there', async () => {
      const { gate } = unlockGate({ getWalletId: async () => 'wallet-b' });
      const unlocking = gate.afterUnlock();

      expect((await state(unlocking)).outcome).toBe('pending');
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      expect(clearMemory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(UNLOCK_REOPEN_WAIT_MS);

      const { outcome, error } = await state(unlocking);
      expect(outcome).toBe('rejected');
      expect(isShownWalletGoneError(error)).toBe(true);
      expect((error as Error).message).toBe(REFUSAL);
    });

    it('ends the unlock refused at once when nothing can reopen the page', async () => {
      uninstall?.();
      uninstall = undefined;
      const { gate } = unlockGate({ getWalletId: async () => 'wallet-b' });

      const { outcome, error } = await state(gate.afterUnlock());

      expect(outcome).toBe('rejected');
      expect(isShownWalletGoneError(error)).toBe(true);
    });

    it('ends the unlock refused within the bound while a reset request of this window holds the reload back', async () => {
      const handler = createWalletResetHandler({ clearMemory, reload, reloadOnBoot });
      uninstall?.();
      uninstall = installWalletResetHandler(handler, bus);
      void handler.request(() => new Promise<void>(() => undefined));
      const { gate } = unlockGate({ getWalletId: async () => 'wallet-b' });
      const unlocking = gate.afterUnlock();

      expect((await state(unlocking)).outcome).toBe('pending');
      expect(reloadOnBoot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(UNLOCK_REOPEN_WAIT_MS);

      expect((await state(unlocking)).outcome).toBe('rejected');
      // The reload it held back came with the end of the wait for the answer.
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    });

    it('lands on Welcome when nothing is booted', async () => {
      const { gate } = unlockGate({ isBooted: async () => false, getWalletId: async () => null });
      void gate.afterUnlock().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('asks nothing for a page that holds no id and shows no wallet content', async () => {
      const { gate, wallet } = unlockGate({ getWalletId: async () => 'wallet-b' }, { shownId: null });
      expect((await state(gate.afterUnlock())).outcome).toBe('resolved');
      expect(wallet.isBooted).not.toHaveBeenCalled();
    });

    it('reopens on the boot route a page that shows wallet content but holds no id: the unlock does not go on', async () => {
      const { gate, wallet } = unlockGate({ getWalletId: async () => 'wallet-b' }, { shownId: null, content: true });
      const unlocking = gate.afterUnlock();

      expect((await state(unlocking)).outcome).toBe('pending');
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      expect(clearMemory).toHaveBeenCalledTimes(1);
      expect(wallet.getWalletId).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(UNLOCK_REOPEN_WAIT_MS);
      expect(isShownWalletGoneError((await state(unlocking)).error)).toBe(true);
    });

    it('lets the unlock go on for a page without an id that reopened for that already', async () => {
      sessionStorage.setItem(WALLET_ID_MISSING_REOPEN_KEY, '1');
      const { gate } = unlockGate({ getWalletId: async () => 'wallet-b' }, { shownId: null, content: true });

      expect((await state(gate.afterUnlock())).outcome).toBe('resolved');
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    it('lets the unlock go on when the answer is not known, and asks again as after a reconnection', async () => {
      const { gate } = unlockGate({ getWalletId: () => Promise.reject(new Error('port gone')) });
      expect((await state(gate.afterUnlock())).outcome).toBe('resolved');
      expect(onUnknown).toHaveBeenCalledTimes(1);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });
  });

  describe('for the background\u2019s UNLOCKED', () => {
    it('lets it through for the id the page shows, and holds it back for another, reopening the page', async () => {
      expect(await unlockGate({}).gate.beforeUnlockedBroadcast()).toBe(true);
      expect(reloadOnBoot).not.toHaveBeenCalled();

      expect(await unlockGate({ getWalletId: async () => 'wallet-b' }).gate.beforeUnlockedBroadcast()).toBe(false);
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    });

    it('holds it back for a page that shows wallet content but holds no id, reopening the page', async () => {
      const { gate } = unlockGate({}, { shownId: null, content: true });
      expect(await gate.beforeUnlockedBroadcast()).toBe(false);
      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    });

    it('asks nothing for a page not started yet, or already unlocked', async () => {
      for (const options of [{ started: false }, { unlocked: true }]) {
        const { gate, wallet } = unlockGate({ getWalletId: async () => 'wallet-b' }, options);
        expect(await gate.beforeUnlockedBroadcast()).toBe(true);
        expect(wallet.isBooted).not.toHaveBeenCalled();
      }
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    it('shares one check with the unlock request that comes with it', async () => {
      const { gate, wallet } = unlockGate({});
      const both = Promise.all([gate.beforeUnlockedBroadcast(), gate.afterUnlock()]);
      await vi.advanceTimersByTimeAsync(0);
      await both;
      expect(wallet.getWalletId).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the wallet data kept in localStorage', () => {
  const owner = () => localStorage.getItem(WALLET_DATA_OWNER_KEY);

  beforeEach(() => {
    localStorage.clear();
    forgetWalletDataOwnerAtLoad();
  });

  afterEach(() => {
    localStorage.clear();
    forgetWalletDataOwnerAtLoad();
  });

  it('is removed, the language and the theme aside, when it belongs to another wallet than the one booted', () => {
    seedLocalStorage();
    localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-a');

    expect(reconcileWalletDataKeys('wallet-a', 'wallet-b', localStorage)).toBe(true);

    expect(storageContents()).toEqual({ ...keptOnly(), [WALLET_DATA_OWNER_KEY]: 'wallet-b' });
  });

  it('is removed, and its owner marked as reset, when nothing is booted', () => {
    seedLocalStorage();
    localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-a');

    expect(reconcileWalletDataKeys('wallet-a', null, localStorage)).toBe(true);

    expect(storageContents()).toEqual(afterReset());
  });

  it('stays when it belongs to the wallet booted, or when no owner was recorded yet', () => {
    seedLocalStorage();
    localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-a');
    expect(reconcileWalletDataKeys('wallet-a', 'wallet-a', localStorage)).toBe(false);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');

    localStorage.removeItem(WALLET_DATA_OWNER_KEY);
    expect(reconcileWalletDataKeys(null, 'wallet-a', localStorage)).toBe(false);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
    expect(owner()).toBe('wallet-a');
  });

  it('after a reset, is removed at each start while nothing is booted, and once more as the next wallet is recorded', () => {
    seedLocalStorage();
    localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-a');
    clearWalletLocalStorage(localStorage);
    // A window that missed the reset writes on, before and between the starts.
    localStorage.setItem('mine_tab_seen', 'true');
    expect(reconcileWalletDataKeys(WALLET_DATA_RESET_MARK, null, localStorage)).toBe(true);
    expect(storageContents()).toEqual(afterReset());

    localStorage.setItem('ecosystem_warning_acknowledged', 'true');
    expect(reconcileWalletDataKeys(null, null, localStorage)).toBe(false);
    expect(storageContents()).toEqual(afterReset());

    localStorage.setItem('version_detail', JSON.stringify({ version: '1.0.9' }));
    expect(reconcileWalletDataKeys(null, 'wallet-b', localStorage)).toBe(false);
    expect(storageContents()).toEqual({ ...keptOnly(), [WALLET_DATA_OWNER_KEY]: 'wallet-b' });

    // What the next wallet writes from then on is its own.
    localStorage.setItem('mine_tab_seen', 'true');
    expect(reconcileWalletDataKeys('wallet-b', 'wallet-b', localStorage)).toBe(false);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
  });

  it('is left alone, with nothing recorded, while nothing is booted on an install from before the owner key', () => {
    seedLocalStorage();
    const before = storageContents();

    expect(reconcileWalletDataKeys(null, null, localStorage)).toBe(false);

    expect(storageContents()).toEqual(before);
    expect(owner()).toBeNull();
  });

  it('ends the same after a reset when two windows start at once, nothing booted or the next wallet', () => {
    for (const id of [null, 'wallet-b']) {
      localStorage.clear();
      seedLocalStorage();
      clearWalletLocalStorage(localStorage);
      localStorage.setItem('mine_tab_seen', 'true');

      const dropped = [1, 2].map(() => reconcileWalletDataKeys(WALLET_DATA_RESET_MARK, id, localStorage));

      expect(dropped).toEqual([true, true]);
      expect(storageContents()).toEqual(id === null ? afterReset() : { ...keptOnly(), [WALLET_DATA_OWNER_KEY]: id });
    }
    // One that acts after the other recorded the next wallet, and that wallet wrote, removes nothing.
    localStorage.setItem('mine_tab_seen', 'true');
    expect(reconcileWalletDataKeys(WALLET_DATA_RESET_MARK, 'wallet-b', localStorage)).toBe(true);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
  });

  it('ends the same whichever of two windows starting at once acts first, keeping what the first wrote since', () => {
    for (const order of [
      ['first', 'second'],
      ['second', 'first']
    ]) {
      localStorage.clear();
      seedLocalStorage();
      localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-a');
      // Both loaded the erased wallet's keys.
      const dropped = order.map(() => reconcileWalletDataKeys('wallet-a', 'wallet-b', localStorage));
      expect(dropped).toEqual([true, true]);
      expect(storageContents()).toEqual({ ...keptOnly(), [WALLET_DATA_OWNER_KEY]: 'wallet-b' });
    }
    // A window that acts after another wrote for the new wallet removes nothing.
    localStorage.setItem('mine_tab_seen', 'true');
    expect(reconcileWalletDataKeys('wallet-a', 'wallet-b', localStorage)).toBe(true);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
  });

  it('is judged, for what the page loaded, by the owner noted as it loaded, once', () => {
    seedLocalStorage();
    localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-a');
    noteWalletDataOwnerAtLoad();
    // Another window cleaned up and recorded the new owner meanwhile.
    localStorage.setItem(WALLET_DATA_OWNER_KEY, 'wallet-b');

    expect(reconcileStoredWalletData('wallet-b').dropLoadedUi).toBe(true);
    // The page's slice is its own from then on.
    expect(reconcileStoredWalletData('wallet-b').dropLoadedUi).toBe(false);
    expect(localStorage.getItem('mine_tab_seen')).toBe('true');
  });
});

describe('the id of the wallet a page shows', () => {
  afterEach(() => {
    forgetShownWalletId();
    sessionStorage.clear();
  });

  it('is the last non-empty string recorded, and nothing else', () => {
    expect(recordShownWalletId(null)).toBe(false);
    expect(recordShownWalletId('')).toBe(false);
    expect(recordShownWalletId(7)).toBe(false);
    expect(getShownWalletId()).toBeUndefined();

    expect(recordShownWalletId('wallet-a')).toBe(true);
    // A page that read everything again under another id holds that one.
    expect(recordShownWalletId('wallet-b')).toBe(true);
    expect(getShownWalletId()).toBe('wallet-b');
  });

  it('is compared only when booted: erased, replaced, kept, unrecorded or unknown', async () => {
    const answers = (booted: unknown, id: unknown) => ({
      isBooted: async () => booted,
      getWalletId: async () => id
    });
    await expect(checkShownWallet('wallet-a', answers(false, null))).resolves.toBe('erased');
    await expect(checkShownWallet('wallet-a', answers(true, 'wallet-b'))).resolves.toBe('replaced');
    await expect(checkShownWallet('wallet-a', answers(true, 'wallet-a'))).resolves.toBe('kept');
    // A page that recorded none cannot tell another wallet from the one it shows.
    await expect(checkShownWallet(undefined, answers(true, 'wallet-b'))).resolves.toBe('unrecorded');
    await expect(checkShownWallet(undefined, answers(false, null))).resolves.toBe('erased');
    await expect(checkShownWallet('wallet-a', answers(true, null))).resolves.toBe('unknown');
    await expect(checkShownWallet('wallet-a', answers('yes', 'wallet-a'))).resolves.toBe('unknown');
  });
});

describe('installing the handler', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('answers WALLET_RESET from the event bus until it is removed', () => {
    const reset = { onWalletReset: vi.fn(), onWalletReplaced: vi.fn(), request: vi.fn() };
    const uninstall = installWalletResetHandler(reset, bus);

    bus.emit(BUS_METHODS.LOCKED);
    expect(reset.onWalletReset).not.toHaveBeenCalled();
    bus.emit(BUS_METHODS.WALLET_RESET);
    expect(reset.onWalletReset).toHaveBeenCalledTimes(1);

    uninstall();
    bus.emit(BUS_METHODS.WALLET_RESET);
    expect(reset.onWalletReset).toHaveBeenCalledTimes(1);
  });

  it('sends a reset request through the installed handler, and straight out without one', async () => {
    let requests = 0;
    const reset: WalletResetHandler = {
      onWalletReset: vi.fn(),
      onWalletReplaced: vi.fn(),
      request: (send) => {
        requests += 1;
        return send();
      }
    };
    const send = vi.fn(async () => 'sent');
    const uninstall = installWalletResetHandler(reset, bus);

    await expect(requestWalletReset(send)).resolves.toBe('sent');
    expect(requests).toBe(1);

    uninstall();
    await expect(requestWalletReset(send)).resolves.toBe('sent');
    expect(requests).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reopens a page refused as out of date once, held back while a reset request of this window is out', async () => {
    const clearMemory = vi.fn();
    const reload = vi.fn();
    const reloadOnBoot = vi.fn();
    const uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload, reloadOnBoot }), bus);
    const answer = deferred<void>();
    const request = requestWalletReset(() => answer.promise);

    reopenOutOfDatePage();
    reopenOutOfDatePage();
    expect(reloadOnBoot).not.toHaveBeenCalled();

    answer.reject(new Error('Password is incorrect'));
    await expect(request).rejects.toThrow('Password is incorrect');
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    uninstall();
    reopenOutOfDatePage();
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
  });

  it('dispatches resetWalletState to the page store on WALLET_RESET', () => {
    const store = { dispatch: vi.fn() };
    const reload = vi.fn();
    const uninstall = installPageWalletResetHandler(store, { reload });

    bus.emit(BUS_METHODS.WALLET_RESET);

    expect(store.dispatch).toHaveBeenCalledWith({ type: 'global/resetWalletState' });
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it('reopens on Welcome without letting the router see the screens on the way out', () => {
    window.history.replaceState(null, '', '#/account/unlock');
    const routed = vi.fn();
    window.addEventListener('hashchange', routed);
    window.addEventListener('popstate', routed);
    const reload = vi.fn();

    reloadOnWelcome(reload);

    expect(window.location.hash).toBe(WALLET_RESET_LANDING_HASH);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(routed).not.toHaveBeenCalled();
    window.removeEventListener('hashchange', routed);
    window.removeEventListener('popstate', routed);
  });

  it('reopens on the boot route without letting the router see the screens on the way out', () => {
    window.history.replaceState(null, '', '#/main');
    const routed = vi.fn();
    window.addEventListener('hashchange', routed);
    window.addEventListener('popstate', routed);
    const reload = vi.fn();

    reloadOnBootRoute(reload);

    expect(window.location.hash).toBe(WALLET_REPLACED_LANDING_HASH);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(routed).not.toHaveBeenCalled();
    window.removeEventListener('hashchange', routed);
    window.removeEventListener('popstate', routed);
  });

  it('lets a window reopen for showing wallet content without an id once, until an id is recorded', () => {
    expect(claimReopenWithoutId()).toBe(true);
    expect(claimReopenWithoutId()).toBe(false);

    recordShownWalletId('wallet-a');
    expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBeNull();
    expect(claimReopenWithoutId()).toBe(true);
  });

  it('lets no window reopen for that when its storage cannot keep the mark', () => {
    const denied = () => {
      throw new Error('The operation is insecure.');
    };
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      }
    } as unknown as Storage;

    expect(claimReopenWithoutId(denied)).toBe(false);
    expect(claimReopenWithoutId(() => full)).toBe(false);
  });
});
