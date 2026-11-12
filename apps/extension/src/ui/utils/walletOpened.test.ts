import { afterEach, describe, expect, it, vi } from 'vitest';

import { unhandledRejectionsDuring } from '../../../../../tests/support/unhandledRejections';
import { noteWalletOpened } from './walletOpened';

// A wallet whose setLastActiveTime gives what `reply` returns or throws. The
// method is a plain function around the spy that counts its calls: a spy
// attaches handlers to the promises it returns, which would hide a rejection
// that noteWalletOpened leaves unhandled.
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

function onPage(pathname: string) {
  window.history.replaceState(null, '', pathname);
}

describe('noteWalletOpened', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it.each(['/popup.html', '/sidepanel.html'])('counts loading %s as one screen action', (pathname) => {
    onPage(pathname);
    const wallet = walletReplying(answered);

    noteWalletOpened(wallet);

    expect(wallet.calls).toHaveBeenCalledTimes(1);
    expect(wallet.calls).toHaveBeenCalledWith();
  });

  it.each(['/notification.html', '/index.html', '/'])(
    'does not count loading %s, which a site can cause',
    (pathname) => {
      onPage(pathname);
      const wallet = walletReplying(answered);

      noteWalletOpened(wallet);

      expect(wallet.calls).not.toHaveBeenCalled();
    }
  );

  it('returns at once, without waiting for the background', () => {
    onPage('/popup.html');
    const wallet = walletReplying(() => new Promise<void>(() => undefined));

    expect(noteWalletOpened(wallet)).toBeUndefined();
    expect(wallet.calls).toHaveBeenCalledTimes(1);
  });

  it('drops a rejection, which crosses the port as a plain object', async () => {
    onPage('/sidepanel.html');
    const wallet = walletReplying(() => Promise.reject({ message: 'The wallet is locking.', stack: 'at lockWallet' }));

    const unhandled = await unhandledRejectionsDuring(() => noteWalletOpened(wallet));

    expect(unhandled).toEqual([]);
    expect(wallet.calls).toHaveBeenCalledTimes(1);
  });

  it('drops a request the port refuses before sending it', async () => {
    onPage('/popup.html');
    // What the port's request throws when all of its request ids are in use.
    const wallet = walletReplying(() => {
      throw Object.assign(new Error('Request limit exceeded.'), { code: -32005 });
    });

    const unhandled = await unhandledRejectionsDuring(() => {
      expect(() => noteWalletOpened(wallet)).not.toThrow();
    });

    expect(unhandled).toEqual([]);
    expect(wallet.calls).toHaveBeenCalledTimes(1);
  });
});
