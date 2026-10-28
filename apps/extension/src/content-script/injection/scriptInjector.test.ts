import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  bcmDispose: vi.fn(),
  bcmSend: vi.fn(),
  connect: vi.fn(),
  getURL: vi.fn(() => 'chrome-extension://qbit/pageProvider.js'),
  listen: vi.fn(),
  nanoid: vi.fn(() => 'test-channel'),
  on: vi.fn(),
  pmDispose: vi.fn(),
  request: vi.fn()
}));

vi.mock('extensionizer', () => ({
  default: { runtime: { getURL: bridge.getURL } }
}));

vi.mock('nanoid', () => ({ nanoid: bridge.nanoid }));

vi.mock('@/shared/utils', () => {
  class PortMessage {
    connect(name: string) {
      bridge.connect(name);
      return this;
    }

    request(data: unknown) {
      return bridge.request(data);
    }

    on(event: string, callback: (data: unknown) => void) {
      bridge.on(event, callback);
      return this;
    }

    dispose() {
      bridge.pmDispose();
    }
  }

  class BroadcastChannelMessage {
    constructor(readonly name: string) {}

    listen(callback: (data: unknown) => Promise<unknown>) {
      bridge.listen(this.name, callback);
      return this;
    }

    send(type: string, data: unknown) {
      bridge.bcmSend(type, data);
    }

    dispose() {
      bridge.bcmDispose();
    }
  }

  return { Message: { BroadcastChannelMessage, PortMessage } };
});

import { injectProviderScript } from './scriptInjector';

describe('provider script bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.head.innerHTML = '<title>Fixture dapp</title><link rel="icon" href="/icon.svg">';
  });

  afterEach(() => {
    document.dispatchEvent(new Event('beforeunload'));
    vi.restoreAllMocks();
  });

  it('checks in from content before inserting the page provider', async () => {
    let acknowledge!: () => void;
    bridge.request.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      })
    );
    const insert = vi.spyOn(document.head, 'insertBefore');

    const injecting = injectProviderScript('channel-1');

    expect(bridge.connect).toHaveBeenCalledWith('qbit-provider');
    expect(bridge.request).toHaveBeenCalledWith({
      source: 'content',
      data: {
        method: 'tabCheckin',
        params: {
          icon: 'http://localhost:3000/icon.svg',
          name: 'Fixture dapp'
        }
      }
    });
    expect(insert).not.toHaveBeenCalled();

    acknowledge();
    await injecting;

    expect(insert).toHaveBeenCalledTimes(1);
    expect(bridge.getURL).toHaveBeenCalledWith('pageProvider.js');
  });

  it('overwrites page-provided source labels', async () => {
    bridge.request.mockResolvedValue(undefined);
    await injectProviderScript('channel-2');
    const pageForward = bridge.listen.mock.calls[0][1] as (data: unknown) => Promise<unknown>;
    const pageData = { source: 'content', method: 'tabCheckin' };

    await pageForward(pageData);

    expect(bridge.request).toHaveBeenNthCalledWith(2, {
      source: 'content',
      data: {
        method: 'tabCheckin',
        params: {
          icon: 'http://localhost:3000/icon.svg',
          name: 'Fixture dapp'
        }
      }
    });
    expect(bridge.request).toHaveBeenLastCalledWith({ source: 'page', data: pageData });
  });

  it('checks in as active when a trusted document is restored from BFCache', async () => {
    bridge.request.mockResolvedValue(undefined);
    const addEventListener = vi.spyOn(window, 'addEventListener');
    await injectProviderScript('channel-bfcache');
    const pageShowListener = addEventListener.mock.calls.find(([type]) => type === 'pageshow')?.[1] as EventListener;
    bridge.request.mockClear();

    pageShowListener({ persisted: true, isTrusted: false } as unknown as Event);
    pageShowListener({ persisted: false, isTrusted: true } as unknown as Event);
    expect(bridge.request).not.toHaveBeenCalled();

    pageShowListener({ persisted: true, isTrusted: true } as unknown as Event);

    expect(bridge.request).toHaveBeenCalledOnce();
    expect(bridge.request).toHaveBeenCalledWith({
      source: 'content',
      data: {
        method: 'tabCheckin',
        params: {
          activeDocument: true,
          icon: 'http://localhost:3000/icon.svg',
          name: 'Fixture dapp'
        }
      }
    });
  });

  it('does not inject when trusted check-in fails', async () => {
    bridge.request.mockRejectedValueOnce(new Error('rejected'));
    const insert = vi.spyOn(document.head, 'insertBefore');

    await expect(injectProviderScript('channel-3')).rejects.toThrow('rejected');

    expect(insert).not.toHaveBeenCalled();
    expect(bridge.bcmDispose).toHaveBeenCalledTimes(1);
    expect(bridge.pmDispose).toHaveBeenCalledTimes(1);
  });
});
