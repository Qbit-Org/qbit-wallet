import { useCallback, useEffect, useState } from 'react';

import { BUS_METHODS, ErrorCodes, type RegtestAccessStatus } from '@qbit/wallet-shared';
import { uiEventBus, useWallet } from '@qbit/wallet-state';

/**
 * Background-owned local-regtest capability as seen by the UI. Reading it
 * never prompts: the background only re-reads `permissions.contains()` and
 * the stored acknowledgement. Updates arrive over the UI event bus whenever
 * the background changes the state (grant, verification, revocation, disable).
 */
export function useRegtestAccessStatus() {
  const wallet = useWallet();
  const [status, setStatus] = useState<RegtestAccessStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await wallet.getRegtestAccessStatus();
      setStatus(next);
      return next;
    } catch {
      setStatus(null);
      return null;
    }
  }, [wallet]);

  useEffect(() => {
    void refresh();
    const handler = (next: RegtestAccessStatus) => {
      if (next && typeof next === 'object' && typeof next.state === 'string') {
        setStatus(next);
      }
    };
    uiEventBus.addEventListener(BUS_METHODS.REGTEST_ACCESS_CHANGED, handler);
    return () => {
      uiEventBus.removeEventListener(BUS_METHODS.REGTEST_ACCESS_CHANGED, handler);
    };
  }, [refresh]);

  return { status, refresh };
}

/**
 * Whether the regtest row must render as locked (explanation + browser
 * permission still required). An unknown status counts as locked so a click
 * cannot race the first read; builds that ship the loopback permission as a
 * required one are never locked here.
 */
export function isRegtestLocked(status: RegtestAccessStatus | null | undefined): boolean {
  if (!status) return true;
  return status.gated && status.state === 'locked';
}

/** Map a background capability error (plain `{ code }` over the port) to user copy. */
export function regtestAccessErrorMessage(error: unknown, t: (key: string) => string): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case ErrorCodes.REGTEST_ACCESS_LOCKED:
      return t('regtest_access_not_enabled');
    case ErrorCodes.REGTEST_SERVICE_UNREACHABLE:
      return t('regtest_service_unavailable');
    case ErrorCodes.REGTEST_SERVICE_UNEXPECTED:
      return t('regtest_service_unexpected');
    default:
      return null;
  }
}
