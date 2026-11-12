import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { unhandledRejectionsDuring } from '../../../../../tests/support/unhandledRejections';
import { noteWalletActivity } from './walletActivity';

// A wallet whose setLastActiveTime gives what `reply` returns or throws. The
// method is a plain function around the spy that counts its calls: a spy
// attaches handlers to the promises it returns, which would hide a rejection
// that noteWalletActivity leaves unhandled.
function walletReplying(reply: () => Promise<void>) {
  const calls = vi.fn();
  return {
    calls,
    setLastActiveTime: (...args: unknown[]): Promise<void> => {
      calls(...args);
      return reply();
    }
  };
}

const answered = async () => undefined;

describe('noteWalletActivity', () => {
  let logged: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    logged = (['error', 'warn', 'info', 'log', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends one request, with no arguments', () => {
    const wallet = walletReplying(answered);

    noteWalletActivity(wallet);

    expect(wallet.calls).toHaveBeenCalledTimes(1);
    expect(wallet.calls).toHaveBeenCalledWith();
  });

  it('returns at once, without waiting for the background', () => {
    const wallet = walletReplying(() => new Promise<void>(() => undefined));

    expect(noteWalletActivity(wallet)).toBeUndefined();
    expect(wallet.calls).toHaveBeenCalledTimes(1);
  });

  it('drops a rejection, which crosses the port as a plain object, without a retry or a log', async () => {
    const wallet = walletReplying(() => Promise.reject({ message: 'The wallet is locking.', stack: 'at lockWallet' }));

    const unhandled = await unhandledRejectionsDuring(() => noteWalletActivity(wallet));

    expect(unhandled).toEqual([]);
    expect(wallet.calls).toHaveBeenCalledTimes(1);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it('drops a request the port refuses before sending it, without a retry or a log', async () => {
    // What the port's request throws when all of its request ids are in use.
    const wallet = walletReplying(() => {
      throw Object.assign(new Error('Request limit exceeded.'), { code: -32005 });
    });

    const unhandled = await unhandledRejectionsDuring(() => {
      expect(() => noteWalletActivity(wallet)).not.toThrow();
    });

    expect(unhandled).toEqual([]);
    expect(wallet.calls).toHaveBeenCalledTimes(1);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});
