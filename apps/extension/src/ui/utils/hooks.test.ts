import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@testing-library/react';

import { unhandledRejectionsDuring } from '../../../../../tests/support/unhandledRejections';
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

  it('neither refreshes nor locks while inactive (#171)', async () => {
    const wallet = { setLastActiveTime: vi.fn(), lockWallet: vi.fn() };
    const { rerender } = renderHook(({ active }) => useWalletKeepalive(wallet, active), {
      initialProps: { active: true }
    });
    await tick();
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);

    // The mnemonic is gone: the ordinary auto-lock applies.
    rerender({ active: false });
    await tick(GRACE_PERIOD_MS);

    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);
    expect(wallet.lockWallet).not.toHaveBeenCalled();
  });

  it('keeps its deadline from the mount when it becomes active again (#171)', async () => {
    const wallet = { setLastActiveTime: vi.fn(), lockWallet: vi.fn() };
    const { rerender } = renderHook(({ active }) => useWalletKeepalive(wallet, active), {
      initialProps: { active: false }
    });
    await tick(GRACE_PERIOD_MS - KEEPALIVE_TICK_MS);

    rerender({ active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(wallet.lockWallet).not.toHaveBeenCalled();
    monotonicNow += KEEPALIVE_TICK_MS;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TICK_MS);

    expect(wallet.lockWallet).toHaveBeenCalledTimes(1);
  });

  it('keeps distrusting the wall clock after a backward jump when it becomes active again (#171)', async () => {
    const wallet = { setLastActiveTime: vi.fn(), lockWallet: vi.fn() };
    const { rerender } = renderHook(({ active }) => useWalletKeepalive(wallet, active), {
      initialProps: { active: true }
    });
    await tick();
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);
    // The wall clock moves back an hour: refreshes stop for good.
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    await tick();
    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    rerender({ active: true });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    await tick();

    expect(wallet.setLastActiveTime).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a failed deadline lock after it becomes inactive (#171)', async () => {
    const wallet = {
      setLastActiveTime: vi.fn(),
      lockWallet: vi.fn().mockRejectedValueOnce(new Error('port closed')).mockResolvedValue(undefined)
    };
    const { rerender } = renderHook(({ active }) => useWalletKeepalive(wallet, active), {
      initialProps: { active: true }
    });
    monotonicNow = GRACE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TICK_MS);
    expect(wallet.lockWallet).toHaveBeenCalledTimes(1);

    // The mnemonic is cleared before the retry; the lock is still owed.
    rerender({ active: false });
    await tick();

    expect(wallet.lockWallet).toHaveBeenCalledTimes(2);
    await tick();
    expect(wallet.lockWallet).toHaveBeenCalledTimes(2);
  });

  it('sends no second lock request while one is in flight, also after it becomes inactive (#171)', async () => {
    const wallet = { setLastActiveTime: vi.fn(), lockWallet: vi.fn(() => new Promise<void>(() => undefined)) };
    const { rerender } = renderHook(({ active }) => useWalletKeepalive(wallet, active), {
      initialProps: { active: true }
    });
    monotonicNow = GRACE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TICK_MS);
    expect(wallet.lockWallet).toHaveBeenCalledTimes(1);

    await tick();
    rerender({ active: false });
    await tick();
    expect(wallet.lockWallet).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'rejects with a plain object, as for a wallet that is locking',
      () => Promise.reject({ message: 'The wallet is locking.', stack: 'at lockWallet' })
    ],
    [
      'throws, as the port does with every request id in use',
      () => {
        throw Object.assign(new Error('Request limit exceeded.'), { code: -32005 });
      }
    ]
  ])('keeps ticking, and leaves nothing unhandled, when a refresh %s', async (_, failure) => {
    // A plain function around the spy that counts the refreshes: a spy
    // attaches handlers to the promises it returns, which would hide a
    // rejection that the keepalive leaves unhandled.
    const refreshes = vi.fn();
    const wallet = {
      setLastActiveTime: (): Promise<void> => {
        refreshes();
        return failure();
      },
      lockWallet: vi.fn()
    };
    renderHook(() => useWalletKeepalive(wallet));

    const unhandled = await unhandledRejectionsDuring(async () => {
      await tick();
      await tick();
      await tick();
    });

    expect(unhandled).toEqual([]);
    expect(refreshes).toHaveBeenCalledTimes(3);
    expect(wallet.lockWallet).not.toHaveBeenCalled();

    // The deadline is still enforced.
    monotonicNow = GRACE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TICK_MS);
    expect(refreshes).toHaveBeenCalledTimes(3);
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
