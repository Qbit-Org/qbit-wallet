/**
 * Event Bus Service
 * Handles communication between UI and background via event bus
 */
import { Message } from '@/shared/utils';
import { BUS_EVENTS, BUS_METHODS, ErrorCodes, MESSAGE_TYPE, PORT_CHANNELS } from '@qbit/wallet-shared';
import { uiEventBus } from '@qbit/wallet-state';

const { PortMessage } = Message;

/**
 * Setup event listeners for UI and background communication. With
 * `beforeUnlocked`, the background's UNLOCKED reaches the page only once that
 * has settled, true, and not at all on false, nor when it fails: the page
 * checks there that it still shows the wallet the background holds before it
 * records the unlock (createUnlockGate). The broadcasts that come while it is
 * pending wait behind it, so the page still takes them in the order they
 * came, each one whatever became of the one before it.
 */
export function setupEventBusListeners(
  portMessageChannel: InstanceType<typeof PortMessage>,
  { beforeUnlocked }: { beforeUnlocked?: () => Promise<boolean> } = {}
): void {
  // Listen for broadcast messages from background
  // background -> UI
  let held: Promise<void> | undefined;
  portMessageChannel.listen((data) => {
    if (data.type !== MESSAGE_TYPE.BG_BROADCAST) return;
    const gated = data.method === BUS_METHODS.UNLOCKED && beforeUnlocked !== undefined;
    if (!gated && !held) {
      uiEventBus.emit(data.method, data.params);
      return;
    }
    // A check that failed may have been about to reopen the page: the
    // unlock is not let through on it.
    const gate = gated ? beforeUnlocked().catch(() => false) : undefined;
    const next = (held ?? Promise.resolve()).then(async () => {
      try {
        if (gate && !(await gate)) return;
        uiEventBus.emit(data.method, data.params);
      } catch (error) {
        // A listener that threw stops neither the broadcasts behind this one,
        // a WALLET_RESET among them, nor goes unhandled.
        console.error('broadcast listener failed', data.method, error);
      }
    });
    held = next;
    void next.finally(() => {
      if (held === next) held = undefined;
    });
  });

  // Listen for UI events to broadcast to background
  // No use for now
  // UI -> background
  uiEventBus.addEventListener(BUS_EVENTS.broadcastToBG, (data) => {
    portMessageChannel.request({
      type: MESSAGE_TYPE.UI_BROADCAST,
      method: data.method,
      params: data.data
    });
  });
}

/**
 * Create a port message channel for communication with background
 */
export function createPortMessageChannel() {
  const portMessageChannel = new PortMessage();
  portMessageChannel.connect(PORT_CHANNELS.POPUP);
  return portMessageChannel;
}

/**
 * Calls `onReconnect` each time `channel` connects to the background again
 * (PortMessage.RECONNECTED). The channel drops its port when the background
 * goes away (its service worker stopped or crashed) and connects a new one
 * only when the page next sends, so a background that started meanwhile could
 * not reach this page: a WALLET_RESET it sent then went to the pages connected
 * at that moment only. `onReconnect` runs once the request that reconnected
 * is posted, not inside the channel's send: what it sends then cannot reach
 * that send, and a port found gone meanwhile rejects only requests already
 * posted.
 */
export function watchPortReconnects(channel: InstanceType<typeof PortMessage>, onReconnect: () => void): void {
  channel.on(PortMessage.RECONNECTED, () => queueMicrotask(onReconnect));
}

export interface WalletProxy {
  [key: string]: any;
}

/**
 * The controller calls a page sends without the id of the wallet it shows:
 * the questions by which it learns whether it is out of date, whether a
 * wallet is set up, its id, and whether the background has started, which it
 * must get answered even when it is. They read nothing of a wallet's data
 * and write nothing.
 */
export const UNJUDGED_CONTROLLER_METHODS: readonly string[] = ['isBooted', 'getWalletId', 'getBackgroundStartupStatus'];

/**
 * The reads a page that shows wallet content but holds no id still sends,
 * without an id (createWalletProxy): those by which its start-up routine
 * comes to show what it shows again after the id (PageStartup), the current
 * account and the accounts, then the wallets and the current one; whether a
 * vault exists, which the page asks at each lock (AccountUpdater) and its
 * start-up routine asks to keep what its store says of it up to date, to
 * send a locked page to the unlock screen; and whether the wallet is
 * unlocked, which a create or a restore asks once it has saved the wallet,
 * whose account the background may have shown the page by then, and the
 * Remove Wallet popover asks after a removal: no more than the current
 * account read tells, which names none while locked. Reads,
 * of nothing the page could give away, so whatever wallet answers them gets
 * nothing of the page's; they change none of a wallet's data, save that the
 * current wallet read (getCurrentKeyring), and the current account read,
 * which goes through it, store the wallet the background falls back to when
 * the one stored as current cannot be used: its own choice, made from its
 * own wallets, the same whichever page asks. A page that holds an id sends it
 * with them, as with every call.
 */
export const WALLET_ID_EXEMPT_READS: readonly string[] = [
  'getCurrentAccount',
  'getAccounts',
  'getKeyrings',
  'getCurrentKeyring',
  'hasVault',
  'isUnlocked'
];

/**
 * The calls a page that shows wallet content but holds no id still sends,
 * without an id, although they are not reads: those that write nothing of
 * any wallet's data. Locking drops the keys of whatever wallet is set up from
 * memory and stores nothing of the page's; like any lock, it also stops the
 * send plans signing before their next signature and drops their drafts. At
 * worst a page that missed a reset locks the wallet set up since, as any
 * window, the auto-lock and the computer's lock can, and only that wallet's
 * password undoes it. So the Lock button works on a page whose id cannot be
 * read. A page that holds an id
 * sends it with them, as with every call: one that is out of date learns so.
 */
export const WALLET_ID_EXEMPT_LOCKS: readonly string[] = ['lockWallet'];

/**
 * The calls a page that shows wallet content but holds no id drops: they
 * resolve with nothing and are not sent, not refused, so they reopen nothing
 * and reject nowhere. The activity ping (noteWalletActivity) locks the wallet
 * when its auto-lock is overdue, and otherwise starts the auto-lock time of
 * whatever wallet is unlocked over. Sent without an id, a page that missed a
 * reset would keep the wallet set up since from locking for as long as
 * someone moves the mouse over it. Dropped, a ping changes nothing: the
 * auto-lock timer still runs out, an overdue auto-lock still locks at the
 * computer's next idle-state change or another page's ping, and this page's
 * next ping, once it holds an id, counts again. Dropping can only leave an
 * overdue lock to one of those; it never extends a session. A page that
 * holds an id sends it with them, as with every call.
 */
export const DROPPED_WITHOUT_WALLET_ID: readonly string[] = ['setLastActiveTime'];

/** What createWalletProxy goes by for the id of the wallet a page shows (sendUnderWalletIdRule). */
export interface WalletIdRule {
  /** The id of the wallet the page shows, while it holds one. */
  walletId?: () => string | undefined;
  /** Whether the page shows wallet content (pageShowsWalletContent). */
  showsWalletContent?: () => boolean;
  /** The error for a call that cannot have the id; it may reopen the page. */
  refuseWithoutWalletId?: () => unknown;
}

/**
 * Sends the controller call `method` under `rule`: `send` is called with the
 * id the call carries, or none. The id goes with every call while the page
 * holds one, UNJUDGED_CONTROLLER_METHODS aside. A page that shows no wallet
 * content sends its calls without an id. A page that shows wallet content but
 * holds no id sends UNJUDGED_CONTROLLER_METHODS, WALLET_ID_EXEMPT_READS and
 * WALLET_ID_EXEMPT_LOCKS without one, and drops DROPPED_WITHOUT_WALLET_ID.
 * Any other call is refused here, at once (refuseWithoutWalletId), and not
 * sent: it was made from what the page shows, and no id the page records
 * later can vouch for that, since the page may show a wallet erased since
 * and the id name the one set up after it, of another seed or the same. Held
 * for the id, it could only be refused later, so it is not held. A page
 * that records an id replaces the accounts and wallets in its store with
 * those it read under it, and drops its transactions (PageStartup); a call
 * made once it holds the id carries it, also one made from what a screen
 * kept in its own state, which stays, as it always did.
 */
export function sendUnderWalletIdRule<T>(
  method: string,
  rule: WalletIdRule,
  send: (walletId: string | undefined) => Promise<T>
): Promise<T> {
  const { walletId, showsWalletContent, refuseWithoutWalletId } = rule;
  if (walletId === undefined || UNJUDGED_CONTROLLER_METHODS.includes(method)) return send(undefined);
  const shownId = walletId();
  if (
    shownId !== undefined ||
    showsWalletContent?.() !== true ||
    WALLET_ID_EXEMPT_READS.includes(method) ||
    WALLET_ID_EXEMPT_LOCKS.includes(method)
  ) {
    return send(shownId);
  }
  if (DROPPED_WITHOUT_WALLET_ID.includes(method)) return Promise.resolve(undefined as T);
  // Wallet content without the id of its wallet: not sent.
  return Promise.reject(refuseWithoutWalletId ? refuseWithoutWalletId() : { code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE });
}

/**
 * Create a wallet proxy that forwards method calls to the background service.
 * - With `afterUnlock`, an unlock answers only once that has settled: the
 *   page checks there, before it records the unlock and shows accounts, that
 *   it still shows the wallet the background holds (createUnlockGate).
 * - With `walletId`, each controller call carries the id of the wallet the
 *   page shows, while it holds one, UNJUDGED_CONTROLLER_METHODS aside. The
 *   background runs a call only if that is the wallet set up now, and refuses
 *   it otherwise with WALLET_PAGE_OUT_OF_DATE (-22), so a page that missed a
 *   reset cannot act on the wallet set up since. A page that holds no id
 *   sends none; its calls are not judged (a reset aside, which the
 *   background refuses from a page that names no wallet while one is
 *   booted), so it sends them only while it shows no wallet content (below).
 * - With `onOutOfDate`, such a refusal also calls it, upon which the page
 *   reopens at once (reopenOutOfDatePage). The refused call's caller gets the
 *   refusal as it came, even if `onOutOfDate` throws; the call is not made
 *   again.
 * - With `showsWalletContent`, a page that shows wallet content sends no call
 *   without the id of that wallet but those that carry nothing of it: the
 *   exempt reads and the lock; and it drops its activity pings
 *   (sendUnderWalletIdRule). The background cannot judge a call that names
 *   no wallet, so one from a page that missed a reset would run against the
 *   wallet set up since. Any other such call is refused in the page
 *   (`refuseWithoutWalletId`, which gives the error, and reopens the page once
 *   per window unless the page is still recovering its id), not sent. A page
 *   that shows no wallet content sends its calls without an id, as before:
 *   it has nothing of another wallet.
 */
export function createWalletProxy(
  portMessageChannel: InstanceType<typeof PortMessage>,
  {
    afterUnlock,
    walletId,
    onOutOfDate,
    showsWalletContent,
    refuseWithoutWalletId
  }: {
    afterUnlock?: () => Promise<void>;
    walletId?: () => string | undefined;
    onOutOfDate?: () => void;
    showsWalletContent?: () => boolean;
    refuseWithoutWalletId?: () => unknown;
  } = {}
): WalletProxy {
  const wallet: Record<string, any> = new Proxy(
    {},
    {
      get(obj, key) {
        switch (key) {
          case 'requestMethod':
            return function (params: any) {
              return portMessageChannel.request({
                type: MESSAGE_TYPE.UI_REQUEST_METHOD,
                method: 'requestMethod',
                params
              });
            };
          default:
            return function (...params: any) {
              const send = (shownId: string | undefined) => {
                let sent = portMessageChannel.request({
                  type: MESSAGE_TYPE.UI_CONTROLLER,
                  method: key,
                  params,
                  ...(shownId !== undefined ? { walletId: shownId } : {})
                });
                if (onOutOfDate) {
                  sent = sent.catch((error: unknown) => {
                    if ((error as { code?: unknown } | null | undefined)?.code === ErrorCodes.WALLET_PAGE_OUT_OF_DATE) {
                      try {
                        onOutOfDate();
                      } catch (reopenError) {
                        console.error('reopening a page out of date failed', reopenError);
                      }
                    }
                    throw error;
                  });
                }
                return sent;
              };
              const request: Promise<unknown> =
                typeof key === 'string'
                  ? sendUnderWalletIdRule(key, { walletId, showsWalletContent, refuseWithoutWalletId }, send)
                  : send(undefined);
              if (key === 'unlock' && afterUnlock) {
                return request.then(async (result) => {
                  await afterUnlock();
                  return result;
                });
              }
              return request;
            };
        }
      }
    }
  );

  return wallet as WalletProxy;
}
