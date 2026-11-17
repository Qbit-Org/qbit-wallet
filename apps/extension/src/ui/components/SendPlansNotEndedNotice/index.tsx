import { useEffect } from 'react';

import { BUS_METHODS } from '@qbit/wallet-shared';
import { uiEventBus, useI18n, useTools } from '@qbit/wallet-state';

/** A count as the background sends it: a whole number, none or more. */
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether `params`, the background's announcement that a wallet removal
 * completed (BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED) as the port delivers it,
 * says the removal could not end all of the removed wallet's send plans: two
 * counts and a flag, `plans` and `unreadable` whole numbers and
 * `storeUnavailable` true or false, with something left. Anything else is
 * read as saying nothing.
 */
export function removalLeftSendPlans(params: unknown): boolean {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return false;
  const { plans, unreadable, storeUnavailable } = params as Record<string, unknown>;
  if (!isCount(plans) || !isCount(unreadable) || typeof storeUnavailable !== 'boolean') return false;
  return plans > 0 || unreadable > 0 || storeUnavailable;
}

/**
 * When a wallet removal completes but could not cancel a payment in
 * progress from the removed wallet, every open wallet page says so, once for
 * that removal, in a lasting warning (15 seconds, closed sooner by the
 * user, announced as an alert): the background holds that payment back,
 * nothing more of it is signed or sent, and it keeps trying to cancel it.
 * The background tells the pages open as the removal completes, and nothing
 * more: not when it later ends what was left, and not a page opened later.
 */
export function SendPlansNotEndedNotice() {
  const tools = useTools();
  const { t } = useI18n();
  useEffect(() => {
    const onNotEnded = (params: unknown) => {
      if (removalLeftSendPlans(params)) {
        tools.toastWarning(t('send_plan_removed_wallet_not_cancelled'), { lasting: true });
      }
    };
    uiEventBus.addEventListener(BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED, onNotEnded);
    return () => uiEventBus.removeEventListener(BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED, onNotEnded);
  }, [tools, t]);
  return null;
}
