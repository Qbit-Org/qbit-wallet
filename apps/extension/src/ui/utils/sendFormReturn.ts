import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'react-redux';
import { matchPath } from 'react-router-dom';

import { getUiType } from '@/ui/web';
import { type AppState, useResetFeeRateBar, useResetUiTxCreateScreen, useWallet } from '@qbit/wallet-state';
import type { ChainType } from '@qbit/wallet-types';

/**
 * The send form a lock took the page away from: the account and network it
 * was shown for, as the page's store had them at the lock.
 *
 * The form's values stay in the page's store through a lock; only the route
 * is lost. Layout notes each redirect to the unlock screen here, and the
 * unlock screen asks here whether an unlock goes back to the form.
 */
export interface InterruptedSendForm {
  readonly address: string;
  readonly chainType: ChainType;
}

// Page memory only: it lives as long as the page, and is written neither to
// the store, which the page saves, nor to any storage or the background.
let interruptedSendForm: InterruptedSendForm | undefined;

/**
 * Layout calls this each time it sends the page to the unlock screen, before
 * it does. It remembers the send form only when the page showed that form
 * with the wallet unlocked (`shownUnlocked`) and a lock now takes the page
 * away from it, outside an approval window; any other redirect forgets any
 * form remembered. A form that mounted locked is taken as never shown
 * unlocked: on a page loaded or restored while locked, or before it knew it
 * was unlocked, its values are whatever the store last saved, from any page,
 * and one reached by Back from the unlock screen is treated the same. An
 * unlock goes Home from it, as before. Nor is a form remembered before the
 * page has finished loading: a redirect made that early replaces the form's
 * history entry instead of adding one. A remembered form thus means that the
 * history entry before the unlock screen is a form this page showed.
 */
export function noteRedirectToUnlock(
  sendFormPath: string,
  state: Pick<AppState, 'accounts' | 'settings'>,
  shownUnlocked: boolean
): void {
  // The route HashRouter shows, matched the way it matches it.
  const pathname = window.location.hash.slice(1).split(/[?#]/)[0] || '/';
  const onSendForm = matchPath(sendFormPath, pathname) !== null && !getUiType().isNotification;
  // Until the page has loaded, the redirect replaces the current history entry
  // instead of adding one: a step back from the unlock screen would then land
  // on whatever came before the form.
  const addsHistoryEntry = document.readyState === 'complete';
  interruptedSendForm =
    onSendForm && shownUnlocked && addsHistoryEntry
      ? { address: state.accounts.current.address, chainType: state.settings.chainType }
      : undefined;
}

/** The send form a lock interrupted in this page, if any. */
export function getInterruptedSendForm(): InterruptedSendForm | undefined {
  return interruptedSendForm;
}

/** Forget the send form a lock interrupted, if any. */
export function forgetInterruptedSendForm(): void {
  interruptedSendForm = undefined;
}

/** Back to the send form, or Home with the form cleared. */
export type SendFormReturnRoute = 'sendForm' | 'home';

/**
 * How long the unlock screen may stay up after the step back to the send
 * form before the page goes Home instead. A step back that works leaves the
 * screen within a frame or two: the traversal fires popstate, and the router
 * renders the form right after. A second is far past that, also on a busy
 * page, and short enough that a step back that went nowhere (there was no
 * earlier entry to go to) does not keep the unlocked wallet behind the unlock
 * screen for long. A hidden page's timers are throttled, which only makes
 * this later: a route can be taken after the user has switched away, as when
 * this screen's own unlock settles then.
 */
export const SEND_FORM_RETURN_FALLBACK_MS = 1000;

/** What a decision needs of the page. */
export interface SendFormReturnPage {
  /** Whether the page's store has the wallet unlocked, now. */
  isUnlocked(): boolean;
  /** Calls `listener` after each change of the page's store; returns its removal. */
  subscribe(listener: () => void): () => void;
  /** The account and network the background has selected, now. */
  readSelection(): Promise<{ address: string | undefined; chainType: ChainType }>;
  /** Takes the route decided on. */
  go(route: SendFormReturnRoute): void;
}

export interface SendFormReturnDecision {
  /** Still waiting for the page to be shown, or for the reads. */
  isPending(): boolean;
  /** The page locked again before a route was taken: the next unlock decides afresh. */
  isRelocked(): boolean;
  /** Read now if still waiting for the page to be shown; nothing otherwise. */
  stopWaiting(): void;
  /** Take no route. */
  drop(): void;
}

/**
 * Decide, for one unlock, whether the page goes back to `form` or Home, and
 * take that route once. With `waitUntilShown` a hidden page waits until it is
 * shown, so that the window that unlocked can switch the account or network
 * first; `stopWaiting` ends the wait sooner, for an unlock found to be this
 * page's own. The account and network are then read from the background: the
 * ones the form was shown for take the page back to it; any other, or a read
 * that failed, Home. The route is taken only if, when the reads land, the page
 * is still unlocked and `form` is still the one remembered. A lock in between
 * takes none and leaves `form` remembered for the next unlock. One read per
 * decision: nothing is retried.
 */
export function decideSendFormReturn(
  form: InterruptedSendForm,
  page: SendFormReturnPage,
  waitUntilShown: boolean
): SendFormReturnDecision {
  let state: 'waiting' | 'reading' | 'routed' | 'dropped' | 'relocked' = 'waiting';
  let unsubscribe = (): void => undefined;
  const end = (next: 'routed' | 'dropped' | 'relocked'): void => {
    state = next;
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
  function onVisibilityChange(): void {
    if (state === 'waiting' && !document.hidden) read();
  }
  function read(): void {
    state = 'reading';
    document.removeEventListener('visibilitychange', onVisibilityChange);
    page.readSelection().then(
      ({ address, chainType }) => settle(address === form.address && chainType === form.chainType),
      // A read that failed names no account or network: unknown is not the same.
      () => settle(false)
    );
  }
  function settle(same: boolean): void {
    if (state !== 'reading') return;
    if (!page.isUnlocked()) {
      end('relocked');
      return;
    }
    if (interruptedSendForm !== form) {
      end('dropped');
      return;
    }
    end('routed');
    forgetInterruptedSendForm();
    page.go(same ? 'sendForm' : 'home');
  }

  // A lock ends the unlock this decision is for, whether it waits or reads.
  unsubscribe = page.subscribe(() => {
    if ((state === 'waiting' || state === 'reading') && !page.isUnlocked()) end('relocked');
  });
  if (waitUntilShown && document.hidden) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  } else {
    read();
  }

  return {
    isPending: () => state === 'waiting' || state === 'reading',
    isRelocked: () => state === 'relocked',
    stopWaiting: () => {
      if (state === 'waiting') read();
    },
    drop: () => {
      if (state === 'waiting' || state === 'reading') end('dropped');
    }
  };
}

/**
 * The unlock screen's way back to a send form a lock interrupted. Both routes
 * an unlock takes on that screen, the page's store turning unlocked and the
 * screen's own unlock, call `route`, and share one decision per unlock.
 * `ownUnlock` is true for an unlock the screen itself completed with no lock
 * since its attempt began, which does not wait for a hidden page to be shown.
 * The store turns unlocked before that unlock returns, so the store's route
 * cannot tell it from an unlock made in another window and starts the
 * decision as for one; the screen's own route, which comes after, then ends
 * any wait it began.
 * `route` is false when no send form was interrupted: the caller then goes
 * Home as it always has. `abandon` forgets the form and ends a pending
 * decision or fallback to Home, for an unlock that goes elsewhere. Leaving the
 * unlock screen does the same: the step back worked, or the page went
 * elsewhere.
 */
export function useSendFormReturn(navigate: (to: 'MainScreen' | '#back') => void): {
  route(ownUnlock: boolean): boolean;
  abandon(): void;
} {
  const store = useStore<AppState>();
  const wallet = useWallet();
  const resetUiTxCreateScreen = useResetUiTxCreateScreen();
  const resetFeeRateBar = useResetFeeRateBar();
  const self = useRef<{ decision?: SendFormReturnDecision; fallback?: ReturnType<typeof setTimeout> }>({}).current;

  const route = useCallback(
    (ownUnlock: boolean): boolean => {
      if (self.decision && !self.decision.isRelocked()) {
        // This screen's own unlock ends a wait the store's route began.
        if (ownUnlock) self.decision.stopWaiting();
        return true;
      }
      const form = getInterruptedSendForm();
      if (form === undefined) return false;
      // Locked again before the decision could start: the next unlock makes it.
      if (!store.getState().global.isUnlocked) return true;
      self.decision = decideSendFormReturn(
        form,
        {
          isUnlocked: () => store.getState().global.isUnlocked,
          subscribe: store.subscribe,
          readSelection: async () => {
            const [account, chainType] = await Promise.all([wallet.getCurrentAccount(), wallet.getChainType()]);
            return { address: account?.address, chainType };
          },
          go: (to) => {
            if (to === 'sendForm') {
              // One step back: the form, with the screen it was opened from behind it.
              navigate('#back');
              // A step back that went nowhere leaves this screen up: then Home,
              // once, keeping the form, whose account and network matched.
              // Unmounting this screen ends the wait.
              self.fallback = setTimeout(() => {
                self.fallback = undefined;
                // This unlock's decision is over; a later unlock decides afresh.
                self.decision = undefined;
                if (store.getState().global.isUnlocked) navigate('MainScreen');
              }, SEND_FORM_RETURN_FALLBACK_MS);
              return;
            }
            // Not shown to another account or network; Send starts it afresh.
            resetUiTxCreateScreen();
            resetFeeRateBar();
            navigate('MainScreen');
          }
        },
        // This screen's own unlock does not wait for the page to be shown.
        !ownUnlock
      );
      return true;
    },
    [self, store, wallet, navigate, resetUiTxCreateScreen, resetFeeRateBar]
  );

  // An unlock that goes elsewhere, or the unlock screen going away: no
  // decision or fallback outlives it, and no later unlock returns to the form.
  const leave = useCallback(() => {
    self.decision?.drop();
    clearTimeout(self.fallback);
    self.fallback = undefined;
    forgetInterruptedSendForm();
  }, [self]);

  useEffect(() => leave, [leave]);

  return useMemo(() => ({ route, abandon: leave }), [route, leave]);
}
