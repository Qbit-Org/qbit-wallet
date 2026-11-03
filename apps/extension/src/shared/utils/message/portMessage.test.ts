import { describe, expect, it, vi } from 'vitest';

import { serializeError } from 'eth-rpc-errors';

import { MESSAGE_TYPE, PORT_CHANNELS } from '@qbit/wallet-shared';

import Message from './index';
import PortMessage from './portMessage';

type Envelope = { _type_: string; data: any };

class TestPort {
  posted: Envelope[] = [];
  disconnect = vi.fn();
  failPosts = false;
  private messageListeners: Array<(message: Envelope) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (listener: (message: Envelope) => void) => this.messageListeners.push(listener) };
  onDisconnect = { addListener: (listener: () => void) => this.disconnectListeners.push(listener) };

  postMessage(message: Envelope) {
    if (this.failPosts) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(message);
  }

  /** The requests this port carried to the background, by method. */
  requestedMethods() {
    return this.posted
      .filter(({ _type_ }) => _type_ === `QBIT_WALLET_${MESSAGE_TYPE.REQUEST}`)
      .map(({ data }) => data.data.data.method);
  }

  /** The background answers the request this port carried for `method`. */
  respond(method: string, answer: { res?: unknown; err?: unknown }) {
    const request = this.posted.find(({ data }) => data.data.data.method === method)!;
    const message = { _type_: `QBIT_WALLET_${MESSAGE_TYPE.RESPONSE}`, data: { ident: request.data.ident, ...answer } };
    this.messageListeners.forEach((listener) => listener(message));
  }

  /** The other end went away: the service worker stopped, or the extension was updated. */
  drop() {
    this.disconnectListeners.forEach((listener) => listener());
  }
}

const ports = vi.hoisted(() => [] as unknown[]);

vi.mock('@/background/webapi/browser', () => ({
  browserRuntimeConnect: () => {
    const port = new TestPort();
    ports.push(port);
    return port;
  }
}));

function connectProviderPort() {
  ports.length = 0;
  const pm = new PortMessage().connect(PORT_CHANNELS.QBIT_PROVIDER);
  return { pm, port: (index: number) => ports[index] as TestPort };
}

const pageRequest = (pm: PortMessage, method: string) => pm.request({ source: 'page', data: { method, params: {} } });

const settled = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined
  );

describe('a provider request whose port drops', () => {
  it('rejects with Disconnected (4900), not the user rejection (4001)', async () => {
    const { pm, port } = connectProviderPort();
    const sending = pageRequest(pm, 'sendQbit');

    port(0).drop();

    await expect(sending).rejects.toMatchObject({ code: 4900, message: expect.stringMatching(/may have run/) });
  });

  it('is not sent again when the next request reconnects', async () => {
    const { pm, port } = connectProviderPort();
    const sending = pageRequest(pm, 'sendQbit');
    port(0).drop();
    await settled(sending);

    const reading = pageRequest(pm, 'getAccounts');
    port(1).respond('getAccounts', { res: ['qb1account'] });

    await expect(reading).resolves.toEqual(['qb1account']);
    expect(port(0).requestedMethods()).toEqual(['sendQbit']);
    expect(port(1).requestedMethods()).toEqual(['getAccounts']);
    expect(ports).toHaveLength(2);
  });

  it('rejects the requests left on a port that fails before it reports its disconnect, and sends only the new one on', async () => {
    const { pm, port } = connectProviderPort();
    const sending = pageRequest(pm, 'sendQbit');
    port(0).failPosts = true;

    const reading = pageRequest(pm, 'getAccounts');

    await expect(sending).rejects.toMatchObject({ code: 4900 });
    expect(port(0).disconnect).toHaveBeenCalledOnce();
    expect(port(1).requestedMethods()).toEqual(['getAccounts']);
    // The replaced port's own disconnect, should it still arrive, leaves the new request alone.
    port(0).drop();
    port(1).respond('getAccounts', { res: ['qb1account'] });
    await expect(reading).resolves.toEqual(['qb1account']);
  });
});

// The page talks to the content script over a BroadcastChannel; this pair
// stands in for it, with the content script relaying each page request to the
// background on its port, as scriptInjector does.
class LoopbackMessage extends Message {
  peer?: LoopbackMessage;

  listen(callback: (data: any) => unknown) {
    this.listenCallback = callback;
    return this;
  }

  send(type: string, data: any) {
    if (type === MESSAGE_TYPE.REQUEST) void this.peer!.onRequest(data);
    else if (type === MESSAGE_TYPE.RESPONSE) void this.peer!.onResponse(data);
  }
}

function pageThroughContentScript() {
  const { pm, port } = connectProviderPort();
  const page = new LoopbackMessage();
  const contentScript = new LoopbackMessage().listen((data) => pm.request({ source: 'page', data }));
  page.peer = contentScript;
  contentScript.peer = page;
  // What the page provider does with a rejection before the dapp sees it.
  const request = (method: string) =>
    page.request({ method, params: {} }).catch((error) => {
      throw serializeError(error);
    });
  return { request, port };
}

describe('what a dapp sees', () => {
  it('gets 4900 for a send whose port dropped', async () => {
    const { request, port } = pageThroughContentScript();
    const sending = request('sendQbit');
    await vi.waitFor(() => expect(port(0).requestedMethods()).toEqual(['sendQbit']));

    port(0).drop();

    await expect(sending).rejects.toMatchObject({ code: 4900 });
  });

  it('gets 4001 for a request the user rejected', async () => {
    const { request, port } = pageThroughContentScript();
    const signing = request('signPsbt');
    await vi.waitFor(() => expect(port(0).requestedMethods()).toEqual(['signPsbt']));

    // As the background's transport answers an approval the user rejected.
    port(0).respond('signPsbt', { err: { code: 4001, message: 'User Cancel' } });

    await expect(signing).rejects.toMatchObject({ code: 4001, message: 'User Cancel' });
  });

  it.each([
    [-32002, 'Qbit Wallet is still starting. Try the request again in a moment.'],
    [-32603, 'Qbit Wallet could not start. Open Qbit Wallet to see why.']
  ])('gets the start-up error %i as the background sent it', async (code, message) => {
    const { request, port } = pageThroughContentScript();
    const reading = request('getAccounts');
    await vi.waitFor(() => expect(port(0).requestedMethods()).toEqual(['getAccounts']));

    port(0).respond('getAccounts', { err: { code, message } });

    await expect(reading).rejects.toEqual({ code, message });
  });
});
