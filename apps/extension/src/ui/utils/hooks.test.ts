import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@testing-library/react';

import { useWalletKeepalive } from './hooks';

const KEEPALIVE_TICK_MS = 10 * 1000;
const GRACE_PERIOD_MS = 10 * 60 * 1000;

describe('useWalletKeepalive', () => {
  let monotonicNow: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_700_000_000_000);
    monotonicNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const tick = async (elapsedMs = KEEPALIVE_TICK_MS) => {
    monotonicNow += elapsedMs;
    await vi.advanceTimersByTimeAsync(elapsedMs);
  };

  it('refreshes activity every tick and locks at the monotonic deadline', async () => {
    const wallet = { setLastActiveTime: vi.fn(), lockWallet: vi.fn() };
    renderHook(() => useWalletKeepalive(wallet));

    await tick();
    await tick();
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(2);
    expect(wallet.lockWallet).not.toHaveBeenCalled();

    monotonicNow = GRACE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TICK_MS);
    expect(wallet.lockWallet).toHaveBeenCalledTimes(1);
  });

  it('keeps enforcing the monotonic deadline and retrying the lock after a backward clock jump', async () => {
    const wallet = {
      setLastActiveTime: vi.fn(),
      lockWallet: vi.fn().mockRejectedValueOnce(new Error('port closed')).mockResolvedValue(undefined)
    };
    renderHook(() => useWalletKeepalive(wallet));

    await tick();
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);

    // The wall clock jumps backwards: refreshes must stop for good, even if
    // the clock later jumps forward again below the original deadline.
    vi.setSystemTime(Date.now() - 60_000);
    await tick();
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 120_000);
    await tick();
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);

    // The interval must survive the jump so the monotonic deadline is still
    // enforced, and a lock rejected by a transient port failure is retried on
    // the next tick.
    monotonicNow = GRACE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TICK_MS);
    expect(wallet.lockWallet).toHaveBeenCalledTimes(1);

    await tick();
    expect(wallet.lockWallet).toHaveBeenCalledTimes(2);
  });
});
