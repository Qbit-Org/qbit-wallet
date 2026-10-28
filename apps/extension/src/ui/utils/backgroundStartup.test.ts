import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundStartupStatus, waitForBackgroundStartup } from './backgroundStartup';

type Answer = BackgroundStartupStatus | Error | undefined;

// A background that gives these answers in turn, then repeats the last one. A
// loop that asks again without waiting would never let the timers run, so the
// stub refuses to answer past a ceiling no test here reaches.
function background(...answers: Answer[]) {
  const getBackgroundStartupStatus = vi.fn(async () => {
    if (getBackgroundStartupStatus.mock.calls.length > 100) {
      throw new Error('asked more than 100 times');
    }
    const answer = answers[Math.min(getBackgroundStartupStatus.mock.calls.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return answer as BackgroundStartupStatus;
  });
  return { getBackgroundStartupStatus };
}

// Read the outcome without awaiting it, so a wait that never ends fails the
// assertion instead of timing the test out.
function settled<T>(promise: Promise<T>) {
  const outcome: { result?: T } = {};
  void promise.then((result) => {
    outcome.result = result;
  });
  return outcome;
}

const starting: BackgroundStartupStatus = { state: 'starting' };
const failed: BackgroundStartupStatus = { state: 'failed', reason: 'stored-settings-unreadable' };

describe('waitForBackgroundStartup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks again after a delay that doubles up to a second while start-up runs', async () => {
    const wallet = background(starting);
    void waitForBackgroundStartup(wallet);

    const askedAt: number[] = [];
    for (let elapsed = 0; elapsed <= 5000; elapsed += 10) {
      while (askedAt.length < wallet.getBackgroundStartupStatus.mock.calls.length) askedAt.push(elapsed);
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(askedAt.slice(0, 9)).toEqual([0, 50, 150, 350, 750, 1550, 2550, 3550, 4550]);
    expect(wallet.getBackgroundStartupStatus).toHaveBeenCalledTimes(9);
  });

  it('stops asking once start-up has failed, and returns why', async () => {
    const wallet = background(starting, starting, failed);
    const waiting = settled(waitForBackgroundStartup(wallet));

    await vi.advanceTimersByTimeAsync(150);
    expect(waiting.result).toEqual(failed);
    expect(wallet.getBackgroundStartupStatus).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(wallet.getBackgroundStartupStatus).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns once start-up has finished', async () => {
    const wallet = background(starting, { state: 'ready' });
    const waiting = settled(waitForBackgroundStartup(wallet));

    await vi.advanceTimersByTimeAsync(50);
    expect(waiting.result).toEqual({ state: 'ready' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats no answer or an unknown answer as still starting, not as failed or ready', async () => {
    const wallet = background(
      new Error('Could not establish connection. Receiving end does not exist.'),
      undefined,
      { state: 'unexpected' } as unknown as BackgroundStartupStatus,
      failed
    );
    const waiting = settled(waitForBackgroundStartup(wallet));

    await vi.advanceTimersByTimeAsync(49);
    expect(wallet.getBackgroundStartupStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 100 + 200);
    expect(waiting.result).toEqual(failed);
    expect(wallet.getBackgroundStartupStatus).toHaveBeenCalledTimes(4);
  });
});
