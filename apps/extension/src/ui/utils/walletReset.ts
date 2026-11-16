import { BUS_METHODS, ErrorCodes, THEME_MODE_STORAGE_KEY } from '@qbit/wallet-shared';
import { resetWalletState, uiEventBus } from '@qbit/wallet-state';

import { forgetInterruptedSendForm } from './sendFormReturn';

/**
 * The localStorage keys a reset keeps: the language (I18nProvider) and the
 * theme (ThemeProvider), which the background keeps through a reset too.
 * Everything else the page keeps there belongs to the erased wallets: the
 * saved `ui` state (`redux_localstorage_simple_ui`), which createAppStore
 * keeps to the display preferences, whether balances are hidden and the
 * balance card expanded, as it saves no send form; and the notice flags
 * `ecosystem_warning_acknowledged`, `mine_tab_seen` and `version_detail`.
 * The owner key (WALLET_DATA_OWNER_KEY) is not removed but marked.
 */
export const KEPT_LOCAL_STORAGE_KEYS: readonly string[] = [
  'i18nextLng',
  'userSelectedLanguage',
  THEME_MODE_STORAGE_KEY
];

/**
 * The id (getWalletId) of the wallet that the wallet-derived keys of
 * localStorage belong to: the notice flags and the saved `ui` state, all but
 * KEPT_LOCAL_STORAGE_KEYS and this key. A reset leaves WALLET_DATA_RESET_MARK
 * in it (clearWalletLocalStorage). A page that starts after a reset it never
 * heard of, one the background finished at its start with no page open,
 * finds another id there, or nothing booted, and drops those keys
 * (reconcileStoredWalletData). Absent, it was never recorded: an install
 * from before this key, whose keys are kept.
 */
export const WALLET_DATA_OWNER_KEY = 'wallet_data_owner';

/**
 * What WALLET_DATA_OWNER_KEY holds after a reset: no wallet's id, which is 32
 * hex digits. The wallet-derived keys found with it belong to erased wallets,
 * whatever wrote them since, as a window that missed the reset still does: a
 * page start removes them while nothing is booted, and once more before it
 * records the wallet set up next as their owner (reconcileWalletDataKeys).
 */
export const WALLET_DATA_RESET_MARK = 'reset';

/** Where a page reopens after a reset: the first-run screen. */
export const WALLET_RESET_LANDING_HASH = '#/welcome';

/**
 * Where a page reopens when the background holds another wallet than the one
 * the page shows (onWalletReplaced): the boot route, which goes on to the
 * unlock screen or to the wallet, as when the page opens.
 */
export const WALLET_REPLACED_LANDING_HASH = '#/';

/**
 * sessionStorage key that carries a reset which erased the wallets but could
 * not clear everything (WALLET_RESET_INCOMPLETE) across the reload, so the
 * page shows it once it reopens. sessionStorage belongs to this window only.
 */
export const WALLET_RESET_NOTICE_KEY = 'wallet_reset_notice';
const INCOMPLETE_NOTICE = 'incomplete';

/**
 * How long a window that asked for the reset waits, after WALLET_RESET, for
 * the answer to its request before it reopens on Welcome without it. The
 * background answers right after it told every window.
 */
export const WALLET_RESET_ANSWER_WAIT_MS = 10_000;

/**
 * Removes every key from `storage` except the language and the theme, and
 * marks the owner key as reset (WALLET_DATA_RESET_MARK): what is written
 * there from then on belongs to the erased wallets too, until a page records
 * the wallet set up next.
 */
export function clearWalletLocalStorage(storage: Storage): void {
  // Collected first: removing while walking the indexes would skip keys.
  const erased: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key !== WALLET_DATA_OWNER_KEY && !KEPT_LOCAL_STORAGE_KEYS.includes(key)) {
      erased.push(key);
    }
  }
  for (const key of erased) {
    storage.removeItem(key);
  }
  // Last, with room made for it. Should it fail, an id the key still holds
  // is not the next wallet's either.
  storage.setItem(WALLET_DATA_OWNER_KEY, WALLET_DATA_RESET_MARK);
}

/** Reopens this page on the Welcome screen with nothing of the old page left in memory. */
export function reloadOnWelcome(reload: () => void = () => window.location.reload()): void {
  // Assigning location.hash would let the router render the screens of the
  // erased wallets on the way out, and a changed hash alone reloads nothing.
  window.history.replaceState(null, '', WALLET_RESET_LANDING_HASH);
  reload();
}

/** Reopens this page on the boot route with nothing of the old page left in memory. */
export function reloadOnBootRoute(reload: () => void = () => window.location.reload()): void {
  // As reloadOnWelcome: the router must not render the old wallet's screens
  // on the way out.
  window.history.replaceState(null, '', WALLET_REPLACED_LANDING_HASH);
  reload();
}

/** Whether the reset this window asked for ended as WALLET_RESET_INCOMPLETE; shown once, so reading it clears it. */
export function takeWalletResetNotice(storage: () => Storage = () => window.sessionStorage): boolean {
  try {
    const notice = storage().getItem(WALLET_RESET_NOTICE_KEY);
    storage().removeItem(WALLET_RESET_NOTICE_KEY);
    return notice === INCOMPLETE_NOTICE;
  } catch {
    return false;
  }
}

export interface WalletResetHandlerOptions {
  /** Drops every piece of wallet state the page holds in memory: the store's resetWalletState. */
  clearMemory: () => void;
  /** Getters, since reading storage throws where privacy settings deny it. */
  localStorage?: () => Storage;
  sessionStorage?: () => Storage;
  /** Reopens the page on the Welcome screen. */
  reload?: () => void;
  /** Reopens the page on the boot route (onWalletReplaced). */
  reloadOnBoot?: () => void;
}

export interface WalletResetHandler {
  /**
   * The background erased every wallet: its BUS_METHODS.WALLET_RESET, or this
   * window's own reset answering so. The page drops what it holds in memory
   * and in localStorage, keeping the language and the theme, marks the owner
   * of what is left there as reset (clearWalletLocalStorage), and reopens on
   * the Welcome screen. Only the first call does anything.
   */
  onWalletReset(): void;
  /**
   * The background holds another wallet than the one this page shows: its id
   * is not the one the page recorded (checkShownWallet), as after a reset
   * this page did not hear of and a wallet made since in another window. The
   * page drops what it holds in memory, the send form included, and reopens
   * on the boot route rather than Welcome: a wallet is set up. localStorage
   * stays as it is: the notice flags; the saved `ui` state, which holds no
   * send form, only display preferences that every window shares and the
   * windows of the wallet set up now may have saved since; and whatever
   * else those windows wrote there. A reset
   * request of this window still out holds the reload back as on
   * WALLET_RESET, until it answers or the wait for its answer ends; a
   * WALLET_RESET meanwhile makes it the Welcome screen. Only the first
   * reload happens.
   */
  onWalletReplaced(): void;
  /**
   * Sends this window's reset request. The background tells every window,
   * this one included, before it answers, so the reload this window would
   * make on that event waits for the answer: the answer settles what the
   * page shows once it reopens.
   */
  request<T>(send: () => Promise<T>): Promise<T>;
}

export function createWalletResetHandler({
  clearMemory,
  localStorage = () => window.localStorage,
  sessionStorage = () => window.sessionStorage,
  reload = () => reloadOnWelcome(),
  reloadOnBoot = () => reloadOnBootRoute()
}: WalletResetHandlerOptions): WalletResetHandler {
  let cleared = false;
  let reloading = false;
  let requestsInFlight = 0;
  let answerWaitOver = false;

  const clear = () => {
    // Memory first: the store saves its display preferences a second after
    // an action that changes one, and a save still due must find the initial
    // ones to write back, not the erased wallets'.
    clearMemory();
    try {
      clearWalletLocalStorage(localStorage());
    } catch {
      // Storage is denied, so the page never kept anything there.
    }
  };

  const onWalletReset = () => {
    if (reloading) return;
    if (requestsInFlight > 0 && !answerWaitOver) {
      // This window's own request is still to answer; its answer reloads, or
      // the wait for it ends.
      if (!cleared) {
        cleared = true;
        clear();
        setTimeout(() => {
          answerWaitOver = true;
          onWalletReset();
        }, WALLET_RESET_ANSWER_WAIT_MS);
      }
      return;
    }
    cleared = true;
    reloading = true;
    // Again right before leaving, in case anything was written meanwhile.
    clear();
    reload();
  };

  let replaced = false;

  const onWalletReplaced = () => {
    if (reloading) return;
    if (cleared) {
      // A WALLET_RESET came meanwhile: no wallet is left, so Welcome.
      onWalletReset();
      return;
    }
    if (requestsInFlight > 0 && !answerWaitOver) {
      // This window's own reset request is still to answer; its answer
      // reloads, or the wait for it ends.
      if (!replaced) {
        replaced = true;
        setTimeout(() => {
          answerWaitOver = true;
          onWalletReplaced();
        }, WALLET_RESET_ANSWER_WAIT_MS);
      }
      return;
    }
    replaced = true;
    reloading = true;
    clearMemory();
    reloadOnBoot();
  };

  const request = async <T>(send: () => Promise<T>): Promise<T> => {
    requestsInFlight += 1;
    let erased = false;
    try {
      const result = await send();
      erased = true;
      return result;
    } catch (error) {
      if ((error as { code?: unknown } | null | undefined)?.code === ErrorCodes.WALLET_RESET_INCOMPLETE) {
        erased = true;
        try {
          sessionStorage().setItem(WALLET_RESET_NOTICE_KEY, INCOMPLETE_NOTICE);
        } catch {
          // Only the notice is lost; the background still finishes the clearing.
        }
      }
      throw error;
    } finally {
      requestsInFlight -= 1;
      // A reset that erased the wallets, or a WALLET_RESET that came while
      // this request was out, ends in the reload it held back; so does a
      // replaced wallet seen meanwhile.
      if (erased || cleared) onWalletReset();
      else if (replaced) onWalletReplaced();
    }
  };

  return { onWalletReset, onWalletReplaced, request };
}

interface EventBus {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

let installed: WalletResetHandler | undefined;

/**
 * Makes `handler` the page's one answer to BUS_METHODS.WALLET_RESET, the same
 * in every window (popup, side panel, tab, approval window). Installed from
 * the UI entry before the first render, so the event is handled whether or
 * not the window is focused and whatever screen it shows.
 */
export function installWalletResetHandler(handler: WalletResetHandler, eventBus: EventBus): () => void {
  installed = handler;
  eventBus.addEventListener(BUS_METHODS.WALLET_RESET, handler.onWalletReset);
  return () => {
    eventBus.removeEventListener(BUS_METHODS.WALLET_RESET, handler.onWalletReset);
    if (installed === handler) installed = undefined;
  };
}

/**
 * The page's handler for `store`, on the UI event bus the port feeds: the
 * store drops the erased wallets with resetWalletState, and the page forgets
 * the send form a lock interrupted (sendFormReturn), so that no unlock takes
 * it back to a form of a wallet that is gone. Both on WALLET_RESET and for a
 * replaced wallet (onWalletReplaced), whose reload a reset request of this
 * window can hold back.
 */
export function installPageWalletResetHandler(
  store: { dispatch(action: ReturnType<typeof resetWalletState>): unknown },
  options: Omit<WalletResetHandlerOptions, 'clearMemory'> = {}
): () => void {
  return installWalletResetHandler(
    createWalletResetHandler({
      ...options,
      clearMemory: () => {
        forgetInterruptedSendForm();
        store.dispatch(resetWalletState());
      }
    }),
    uiEventBus
  );
}

/**
 * The background refused a request of this page as out of date
 * (WALLET_PAGE_OUT_OF_DATE): the page shows a wallet that is no longer set
 * up. That answer is the background's own judgement of the id the request
 * carried, so the page acts on it at once, whatever its checks are doing: it
 * drops what it holds as for a replaced wallet and reopens on the boot route,
 * which goes on to Welcome when nothing is set up. Once however many requests
 * are refused, and held back by a reset request of this window still out, as
 * onWalletReplaced is.
 */
export function reopenOutOfDatePage(): void {
  installed?.onWalletReplaced();
}

/** Sends this window's reset request through the installed handler (see WalletResetHandler.request). */
export function requestWalletReset<T>(send: () => Promise<T>): Promise<T> {
  return installed ? installed.request(send) : send();
}

/**
 * How long a page waits for a background that is still starting before it
 * asks again whether the background still holds its wallet, as long as the
 * background gives a website's request to finish starting.
 */
export const RECONNECT_STARTUP_WAIT_MS = 30_000;

let shownWalletId: string | undefined;

/**
 * sessionStorage key: this window reopened because it showed wallet content
 * without the id of the wallet it belongs to, as when the id's first save
 * kept failing (claimReopenWithoutId). A window does that once; reopened, a
 * page that still records no id stays as it is. Recording an id clears it.
 * sessionStorage belongs to this window only, and outlives its reloads.
 */
export const WALLET_ID_MISSING_REOPEN_KEY = 'wallet_id_missing_reopen';

/**
 * Whether this window may reopen for showing wallet content without an id,
 * marking that it did: the first time only. Storage that cannot keep the mark
 * allows none, so a store that keeps failing cannot make the page reopen
 * again and again.
 */
export function claimReopenWithoutId(storage: () => Storage = () => window.sessionStorage): boolean {
  try {
    if (storage().getItem(WALLET_ID_MISSING_REOPEN_KEY) !== null) return false;
    storage().setItem(WALLET_ID_MISSING_REOPEN_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Records the id (getWalletId) of the wallet whose state this page shows, for
 * the checks after a reconnection and at an unlock (checkShownWallet). The
 * page's start-up routine (PageStartup) records it together with the state
 * it belongs to: once the reads that go with it, sent after it, have
 * succeeded; a page that set a wallet up itself, as the first-run page does,
 * gets one in its first run once a wallet is booted. A page that has read
 * everything again under another id holds that one. Null, or anything but a
 * non-empty string, records nothing. Recording one also clears this
 * window's mark of a reopen without an id (claimReopenWithoutId).
 */
export function recordShownWalletId(id: unknown): boolean {
  if (typeof id !== 'string' || id === '') return false;
  shownWalletId = id;
  try {
    // Judged by its id from now on: a later page of this window without one
    // may reopen for that once more.
    window.sessionStorage.removeItem(WALLET_ID_MISSING_REOPEN_KEY);
  } catch {
    // Storage that is denied kept no mark either.
  }
  return true;
}

/** The id recordShownWalletId recorded, if any. */
export function getShownWalletId(): string | undefined {
  return shownWalletId;
}

/** Forgets the recorded id, and any read of it under way, as a page that opens afresh has neither. */
export function forgetShownWalletId(): void {
  shownWalletId = undefined;
  walletIdRead = undefined;
}

/**
 * Whether a page shows wallet content: started (isReady), with an account or
 * the wallets in its store. One that shows none has nothing of a wallet to
 * compare or to write: a page still starting, the first-run page before its
 * first wallet, a page opened locked that never loaded an account. The
 * checks after a reconnection and at an unlock, and the wallet proxy, which
 * sends no request of such content without its wallet's id, go by this one
 * predicate.
 */
export function pageShowsWalletContent(state: {
  global: { isReady: boolean };
  accounts: { current: { address: string }; accounts: readonly unknown[] };
  keyrings: { keyrings: readonly unknown[] };
}): boolean {
  return (
    state.global.isReady &&
    (state.accounts.current.address !== '' || state.accounts.accounts.length > 0 || state.keyrings.keyrings.length > 0)
  );
}

// The run of the page's start-up routine that reads the id, while one is
// under way (noteWalletIdRead).
let walletIdRead: Promise<void> | undefined;

/**
 * Notes that `run`, a run of the page's start-up routine (PageStartup) on a
 * page that holds no id, reads the id of the wallet set up, until it settles,
 * with an id recorded or not: a request held for the id waits for it
 * (waitForShownWalletId).
 */
export function noteWalletIdRead(run: Promise<unknown>): void {
  const read = run.then(
    () => undefined,
    () => undefined
  );
  walletIdRead = read;
  void read.then(() => {
    if (walletIdRead === read) walletIdRead = undefined;
  });
}

/**
 * How long a request held for the id (createWalletProxy) waits for the read
 * under way: longer than a start-up run with its retries takes.
 */
export const WALLET_ID_WAIT_MS = 10_000;

/**
 * The id this page holds, once a read of it under way has settled, waiting at
 * most `ms` for that; undefined when the page holds none then. With no read
 * under way it answers at once. Never rejects.
 */
export async function waitForShownWalletId(ms: number = WALLET_ID_WAIT_MS): Promise<string | undefined> {
  const read = walletIdRead;
  if (shownWalletId === undefined && read) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([read, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }
  return shownWalletId;
}

/**
 * The page's refusal of a request that shows wallet content but would leave
 * without the id of its wallet (createWalletProxy): the out-of-date error in
 * the background's shape (WALLET_PAGE_OUT_OF_DATE, `message`), so every
 * screen handles it as it handles the background's. It also reopens the page
 * on the boot route, once per window (claimReopenWithoutId); the reopened
 * page, if it still records no id, refuses such requests and stays.
 */
export function refuseWithoutWalletId(message: string): { code: number; message: string } {
  if (installed && claimReopenWithoutId()) installed.onWalletReplaced();
  return { code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE, message };
}

/** See checkShownWallet. */
export type ShownWalletCheck = 'erased' | 'replaced' | 'kept' | 'unrecorded' | 'unknown';

/**
 * What became of the wallet this page shows, asked once its connection to
 * the background came back (createReconnectReconcile):
 * - 'erased': nothing is booted any more, as after WALLET_RESET;
 * - 'replaced': the background is booted with another wallet, whose id is
 *   not `shownId`, the one the page recorded. The id changes only when the
 *   wallets are erased: locks and unlocks, password changes, wallets and
 *   accounts added, removed or switched, and network changes all keep it;
 * - 'kept': the ids match;
 * - 'unrecorded': the background is booted, and the page recorded no id, so
 *   nothing tells whether what it shows belongs to the wallet set up now. A
 *   page that shows wallet content then reopens, once (the callers); one that
 *   shows none has nothing to compare;
 * - 'unknown': a question failed, was held and then refused, or got no
 *   clear answer. A booted background whose id reads null has just begun a
 *   reset.
 * Both questions go out at once, as this is called; without an id, only
 * whether a wallet is booted.
 */
export async function checkShownWallet(
  shownId: string | undefined,
  wallet: { isBooted(): Promise<unknown>; getWalletId(): Promise<unknown> }
): Promise<ShownWalletCheck> {
  let booted: PromiseSettledResult<unknown>;
  let id: PromiseSettledResult<unknown>;
  try {
    [booted, id] = await Promise.allSettled([
      wallet.isBooted(),
      shownId === undefined ? Promise.resolve(undefined) : wallet.getWalletId()
    ]);
  } catch {
    return 'unknown';
  }
  if (booted.status === 'rejected') return 'unknown';
  if (booted.value === false) return 'erased';
  if (booted.value !== true) return 'unknown';
  if (shownId === undefined) return 'unrecorded';
  if (id.status === 'rejected' || typeof id.value !== 'string' || id.value === '') return 'unknown';
  return id.value === shownId ? 'kept' : 'replaced';
}

/**
 * The page's answer to its connection to the background coming back (see
 * watchPortReconnects). A background that starts again finishes a reset left
 * pending (an outcome it could not tell, or a service worker that died
 * mid-reset) and tells the pages connected then, which this one was not; and
 * a wallet may have been made in another window since, which isBooted alone
 * does not tell from the one the page shows. So a page that holds a wallet
 * checks it against the id it recorded (checkShownWallet): 'erased' is
 * handled as WALLET_RESET, 'replaced' reopens the page on the boot route
 * (onWalletReplaced), and 'kept' changes nothing. A page that holds no id
 * but shows wallet content (`showsWalletContent`), as one whose id read kept
 * failing, cannot tell either way, so it reopens on the boot route too, once
 * per window (claimReopenWithoutId); one that shows none has nothing to
 * compare. When the answer is not known, as from a background still
 * starting, the page waits for start-up (`waitForStartup`, which must end,
 * ready or not) and asks once more; a second unknown changes nothing. A page
 * that holds no wallet, such as a fresh one or the first-run page before its
 * first wallet, asks nothing; neither does one whose question is still out.
 *
 * watchPortReconnects calls it once the request that brought the connection
 * back has gone out, so its two questions follow that request. A page that
 * holds an id sends it with that request, and the background refuses it
 * (WALLET_PAGE_OUT_OF_DATE) if another wallet, or none, is set up now, upon
 * which the page reopens at once (reopenOutOfDatePage). A page that shows
 * wallet content without an id sends no such request at all: the wallet
 * proxy holds it for the id, or refuses it (refuseWithoutWalletId). One that
 * shows none sends it without an id, not judged, having nothing of another
 * wallet to write. An unlock is checked on its own before the page shows
 * anything (createUnlockGate).
 */
export function createReconnectReconcile({
  holdsWallet,
  shownWalletId,
  showsWalletContent,
  wallet,
  waitForStartup
}: {
  holdsWallet: () => boolean;
  shownWalletId: () => string | undefined;
  /** Whether the page, started, shows an account or the wallets. */
  showsWalletContent: () => boolean;
  wallet: { isBooted(): Promise<unknown>; getWalletId(): Promise<unknown> };
  waitForStartup: () => Promise<boolean>;
}): () => void {
  let asking = false;
  const ask = async () => {
    let outcome = await checkShownWallet(shownWalletId(), wallet);
    if (outcome === 'unknown') {
      const ready = await waitForStartup().catch(() => false);
      if (!ready || !holdsWallet()) return;
      outcome = await checkShownWallet(shownWalletId(), wallet);
    }
    if (outcome === 'erased') {
      installed?.onWalletReset();
    } else if (outcome === 'replaced') {
      installed?.onWalletReplaced();
    } else if (outcome === 'unrecorded' && installed && showsWalletContent() && claimReopenWithoutId()) {
      installed.onWalletReplaced();
    }
  };
  return () => {
    if (asking || !holdsWallet()) return;
    asking = true;
    void ask().finally(() => {
      asking = false;
    });
  };
}

/**
 * How long an unlock that found the page showing another wallet waits for the
 * reload that reopens the page, before it ends refused (ShownWalletGoneError):
 * longer than a reset request of this window holds that reload back.
 */
export const UNLOCK_REOPEN_WAIT_MS = WALLET_RESET_ANSWER_WAIT_MS + 1_000;

/**
 * The refusal of an unlock on a page that shows a wallet the background no
 * longer holds, when the page was not reopened within UNLOCK_REOPEN_WAIT_MS,
 * or nothing can reopen it. Its message is for the screen to show.
 */
export class ShownWalletGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShownWalletGoneError';
  }
}

/** Whether `error` is a ShownWalletGoneError. */
export function isShownWalletGoneError(error: unknown): error is ShownWalletGoneError {
  return error instanceof ShownWalletGoneError;
}

/**
 * The check of the wallet's id at each unlock of a started page that holds
 * one, made before the page records the unlock and shows wallet content,
 * however the unlock comes:
 * - `beforeUnlockedBroadcast`, for the background's UNLOCKED, which it sends
 *   during an unlock, this page's own or another window's, before it answers
 *   the unlock; setupEventBusListeners holds the event, and those after it,
 *   until this settles, and drops it for a page that reopens;
 * - `afterUnlock`, for this page's own unlock request, its password or Touch
 *   ID (createWalletProxy), which answers once this settles.
 * A check after a reconnection that could not tell (a background that kept
 * starting) leaves a page that missed a reset with its erased wallet; an
 * unlock with the password of the wallet made since must not show it.
 *
 * The same id lets the unlock go on, and so does a page that holds no id and
 * shows no wallet content (`showsWalletContent`). A different id is handled
 * as after a reconnection, and nothing booted as WALLET_RESET; a page that
 * holds no id but shows wallet content reopens on the boot route, once per
 * window, as after a reconnection: all these reopen the page, so the unlock
 * does not go on. When the answer is not known, it goes on, and `onUnknown`
 * asks again, as after a reconnection. One check runs for both at once. The
 * id changes only with a reset, so nothing else can make it differ.
 *
 * An unlock always ends: one that does not go on is refused with a
 * ShownWalletGoneError (`refusal`) at once when nothing can reopen the page,
 * and otherwise after UNLOCK_REOPEN_WAIT_MS, unless the reload has taken the
 * page by then, so a website's unlock window never waits on it.
 */
export function createUnlockGate({
  holdsWallet,
  shownWalletId,
  showsWalletContent,
  isStarted,
  isUnlocked,
  wallet,
  onUnknown,
  refusal
}: {
  holdsWallet: () => boolean;
  shownWalletId: () => string | undefined;
  /** Whether the page, started, shows an account or the wallets. */
  showsWalletContent: () => boolean;
  isStarted: () => boolean;
  isUnlocked: () => boolean;
  wallet: { isBooted(): Promise<unknown>; getWalletId(): Promise<unknown> };
  onUnknown: () => void;
  refusal: () => string;
}): { beforeUnlockedBroadcast: () => Promise<boolean>; afterUnlock: () => Promise<void> } {
  let checking: Promise<'go' | 'reopen'> | undefined;
  // Once the page is to reopen, no later unlock goes on, though the page has
  // dropped by then the wallet it held.
  let reopened = false;
  let reopening = false;

  const check = async (): Promise<'go' | 'reopen'> => {
    if (reopened) return 'reopen';
    const shownId = shownWalletId();
    if (!holdsWallet() || (shownId === undefined && !showsWalletContent())) return 'go';
    const outcome = await checkShownWallet(shownId, wallet);
    if (
      outcome === 'replaced' ||
      outcome === 'erased' ||
      (outcome === 'unrecorded' && installed !== undefined && claimReopenWithoutId())
    ) {
      reopened = true;
      reopening = installed !== undefined;
      if (outcome === 'erased') {
        installed?.onWalletReset();
      } else {
        installed?.onWalletReplaced();
      }
      return 'reopen';
    }
    if (outcome === 'unknown') onUnknown();
    return 'go';
  };

  const verdict = () => {
    checking ??= check().finally(() => {
      checking = undefined;
    });
    return checking;
  };

  return {
    beforeUnlockedBroadcast: async () => {
      if (!isStarted() || isUnlocked()) return true;
      return (await verdict()) === 'go';
    },
    afterUnlock: async () => {
      if ((await verdict()) === 'go') return;
      if (reopening) {
        // The reload takes the page, unless something holds it back.
        await new Promise((resolve) => setTimeout(resolve, UNLOCK_REOPEN_WAIT_MS));
      }
      throw new ShownWalletGoneError(refusal());
    }
  };
}

// The owner (WALLET_DATA_OWNER_KEY) of the wallet-derived keys as this page
// found them when it loaded, with them, the display preferences its store
// loaded from the saved `ui` state; then the id the page's own `ui` state
// belongs to. Undefined until read.
let walletDataOwnerAtLoad: string | null | undefined;

function readWalletDataOwner(storage: () => Storage): string | null {
  try {
    return storage().getItem(WALLET_DATA_OWNER_KEY);
  } catch {
    return null;
  }
}

/**
 * Notes, as the page store loads the display preferences of the saved `ui`
 * state, which wallet the wallet-derived keys belong to, or that a reset left
 * them to none (WALLET_DATA_RESET_MARK): the UI entry calls it right after
 * createAppStore, whose load only rewrites a saved `ui` state that is there,
 * to those preferences, and never brings back one a reset removed. Another
 * window may change them before this page's check.
 */
export function noteWalletDataOwnerAtLoad(storage: () => Storage = () => window.localStorage): void {
  walletDataOwnerAtLoad = readWalletDataOwner(storage);
}

/** Forgets the note, as a page that opens afresh has none. */
export function forgetWalletDataOwnerAtLoad(): void {
  walletDataOwnerAtLoad = undefined;
}

/**
 * Keeps the wallet-derived keys of `storage` with the wallet they belong to,
 * given `id`, the background's definite answer to getWalletId: a string, or
 * null when nothing is booted. By the owner recorded (WALLET_DATA_OWNER_KEY):
 * - Another wallet's id, or the reset mark (WALLET_DATA_RESET_MARK): the keys
 *   belong to erased wallets, whatever wrote them since. They are removed as
 *   on WALLET_RESET, the language and the theme staying, and `id` is
 *   recorded. With nothing booted the mark stays instead: each page start
 *   removes them again, as does the first one that records the next
 *   wallet's id.
 * - `id`: nothing is removed.
 * - None, as on the first start of an install from before the owner key:
 *   nothing is removed, and `id` is recorded, if one is booted.
 * Windows starting at once all end in the same state, whichever acts first:
 * each removes only while the owner recorded is not `id`, so none removes
 * what another wrote for `id` since.
 * Returns whether the `ui` state a page loaded when the owner was
 * `loadedOwner` belongs to another wallet than `id`: the page then drops it
 * from memory too, or it would save it back.
 */
export function reconcileWalletDataKeys(loadedOwner: string | null, id: string | null, storage: Storage): boolean {
  const owner = storage.getItem(WALLET_DATA_OWNER_KEY);
  if (owner !== null && owner !== id) {
    clearWalletLocalStorage(storage);
  }
  if (id !== null && storage.getItem(WALLET_DATA_OWNER_KEY) !== id) {
    storage.setItem(WALLET_DATA_OWNER_KEY, id);
  }
  return loadedOwner !== null && loadedOwner !== id;
}

/**
 * reconcileWalletDataKeys for this page, called by its start-up on each
 * definite getWalletId answer until it records its id; the owner the page
 * loaded with is the one noteWalletDataOwnerAtLoad noted. Storage that is
 * denied, or full, keeps nothing removed; the next page start tries again.
 */
export function reconcileStoredWalletData(
  id: string | null,
  storage: () => Storage = () => window.localStorage
): { dropLoadedUi: boolean } {
  if (walletDataOwnerAtLoad === undefined) {
    walletDataOwnerAtLoad = readWalletDataOwner(storage);
  }
  const loadedOwner = walletDataOwnerAtLoad;
  // From now on the page's `ui` slice is its own, for `id`.
  walletDataOwnerAtLoad = id;
  let dropLoadedUi = loadedOwner !== null && loadedOwner !== id;
  try {
    dropLoadedUi = reconcileWalletDataKeys(loadedOwner, id, storage());
  } catch {
    // Denied, or full: what could not be removed stays until the next start.
  }
  return { dropLoadedUi };
}

/**
 * What became of the wallets after this window's reset request was refused
 * with neither QBIT_RECOVERY_REMOVAL_ACK_REQUIRED nor WALLET_RESET_INCOMPLETE.
 * The background sends such a refusal before it erases anything, but the
 * request itself can be lost (the port disconnected, code 4900, or any other
 * transport failure): the reset may then have run, and its WALLET_RESET may
 * have been lost with the port. So the page asks the background whether a
 * wallet is still set up:
 * - 'erased': it is not, so the page drops the erased wallets and reopens on
 *   the Welcome screen, as on WALLET_RESET;
 * - 'kept': it is, so the reset did not run;
 * - 'unknown': that question failed too, or got no clear answer.
 */
export async function reconcileWalletReset(isBooted: () => Promise<unknown>): Promise<'erased' | 'kept' | 'unknown'> {
  let booted: unknown;
  try {
    booted = await isBooted();
  } catch {
    return 'unknown';
  }
  if (booted === false) {
    installed?.onWalletReset();
    return 'erased';
  }
  return booted === true ? 'kept' : 'unknown';
}
