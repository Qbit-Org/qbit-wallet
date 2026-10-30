import { ShimEvent } from './events';

/**
 * In-page stand-in for `chrome.runtime` ports and one-shot messages.
 *
 * In the app the background and the UI share one JavaScript context, but they
 * keep talking through ports exactly as they do in the extension. That keeps
 * the background's sender checks and per-port bookkeeping on the same code
 * path. The emulation follows the Chrome semantics the wallet relies on:
 *
 * - messages are JSON-serialized, so neither side can share or mutate the
 *   other's objects (Chrome extension messaging is JSON-based too);
 * - delivery is asynchronous and in order;
 * - `disconnect()` fires `onDisconnect` on the other end only;
 * - a connect with no `onConnect` listener disconnects the caller.
 */

export interface MessageSender {
  id: string;
  url: string;
  origin: string;
}

type MessageListener = (message: any, port: ShimPort) => void;
type DisconnectListener = (port: ShimPort) => void;

const DISCONNECTED_PORT_ERROR = 'Attempting to use a disconnected port object';

export function serializeMessage<T>(message: T): T {
  if (message === undefined) return message;
  return JSON.parse(JSON.stringify(message));
}

const defer = (fn: () => void) => setTimeout(fn, 0);

export class ShimPort {
  readonly onMessage = new ShimEvent<MessageListener>();
  readonly onDisconnect = new ShimEvent<DisconnectListener>();
  peer: ShimPort | null = null;
  private connected = true;

  constructor(
    readonly name: string,
    readonly sender?: MessageSender
  ) {}

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error(DISCONNECTED_PORT_ERROR);
    const data = serializeMessage(message);
    const peer = this.peer;
    defer(() => {
      if (peer && peer.connected) peer.onMessage.dispatch(data, peer);
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    const peer = this.peer;
    if (peer && peer.connected) {
      peer.connected = false;
      defer(() => peer.onDisconnect.dispatch(peer));
    }
  }
}

export interface RuntimeMessaging {
  onConnect: ShimEvent<(port: ShimPort) => void>;
  onMessage: ShimEvent<(message: any, sender: MessageSender, sendResponse: (response?: any) => void) => any>;
  connect(extensionIdOrInfo?: string | { name?: string }, connectInfo?: { name?: string }): ShimPort;
  sendMessage(...args: any[]): Promise<any> | undefined;
}

export function createRuntimeMessaging(getSender: () => MessageSender): RuntimeMessaging {
  const onConnect = new ShimEvent<(port: ShimPort) => void>();
  const onMessage = new ShimEvent<
    (message: any, sender: MessageSender, sendResponse: (response?: any) => void) => any
  >();

  function connect(extensionIdOrInfo?: string | { name?: string }, connectInfo?: { name?: string }): ShimPort {
    const info = typeof extensionIdOrInfo === 'object' && extensionIdOrInfo !== null ? extensionIdOrInfo : connectInfo;
    const name = info?.name ?? '';

    const callerPort = new ShimPort(name);
    const receiverPort = new ShimPort(name, getSender());
    callerPort.peer = receiverPort;
    receiverPort.peer = callerPort;

    defer(() => {
      if (!onConnect.hasListeners()) {
        // Closing from the receiving end is what fires the caller's onDisconnect.
        receiverPort.disconnect();
        return;
      }
      onConnect.dispatch(receiverPort);
    });

    return callerPort;
  }

  /**
   * `chrome.runtime.sendMessage(message, [options], [callback])`. Resolves with
   * the first response; a listener keeps the channel open by returning `true`.
   */
  function sendMessage(...args: any[]): Promise<any> | undefined {
    const message = args[0];
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const sender = getSender();
    const data = serializeMessage(message);

    const result = new Promise<any>((resolve) => {
      defer(() => {
        let settled = false;
        const sendResponse = (response?: any) => {
          if (settled) return;
          settled = true;
          resolve(serializeMessage(response));
        };
        const returns = onMessage.dispatch(data, sender, sendResponse);
        const keepsChannelOpen = returns.some((value) => value === true);
        if (!keepsChannelOpen && !settled) {
          settled = true;
          resolve(undefined);
        }
      });
    });

    if (callback) {
      result.then(callback);
      return undefined;
    }
    return result;
  }

  return { onConnect, onMessage, connect, sendMessage };
}
