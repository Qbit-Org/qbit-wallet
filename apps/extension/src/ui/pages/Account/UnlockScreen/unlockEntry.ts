import { routes } from '@/ui/pages/MainRoute';
import { getUiType } from '@/ui/web';

/**
 * Whether a step to the unlock screen takes the place of the history entry
 * shown now, instead of adding one.
 *
 * Every route a lock takes to the unlock screen asks here (Layout's redirect
 * and navToLock), so one lock leaves one unlock entry however many of them
 * run. From Home the unlock entry takes Home's place and the unlock puts Home
 * back, so the history is as it was before the lock. From the unlock screen
 * itself, a second route for the same lock replaces the first one's entry.
 * From the send confirm screen the unlock entry takes its place too, and the
 * unlock puts Home there: that screen holds a transaction to sign in its
 * route state, and coming back to it by Back after the unlock would offer to
 * sign that transaction again, spending another signature and broadcasting a
 * payment that may have gone out already. Back then gives the screen before
 * it, such as the send form. From any other screen the step adds an entry,
 * so Back after the unlock returns to that screen. An approval window adds
 * one, as it always has.
 */
export function enteringUnlockReplaces(): boolean {
  if (getUiType().isNotification) {
    return false;
  }
  // The route HashRouter shows, read from the address: a redirect made a
  // moment ago has already changed it, before the router catches up.
  const shown = window.location.hash.slice(1).split(/[?#]/)[0] || '/';
  return (
    shown === routes.MainScreen.path ||
    shown === routes.UnlockScreen.path ||
    shown === routes.TxConfirmScreen.path
  );
}
