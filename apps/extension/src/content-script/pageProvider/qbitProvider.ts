import { QbitAPIMethods } from './qbitAPI';
import { initializeProvider, requestMethod } from './providerCore';
import type {
  P2mrMessageProof,
  QbitBalance,
  QbitChain,
  QbitNetwork,
  QbitProviderEvent,
  QbitProviderEventMap,
  QbitProviderListener,
  QbitSendOptions,
  QbitSignPsbtOptions
} from './types';

const SUPPORTED_EVENTS = new Set<QbitProviderEvent>([
  'accountsChanged',
  'networkChanged',
  'chainChanged',
  'disconnect'
]);

type AnyListener = (payload: never) => void;

export class QbitProvider {
  readonly #api: QbitAPIMethods;
  readonly #listeners = new Map<QbitProviderEvent, Set<AnyListener>>();

  constructor() {
    this.#api = new QbitAPIMethods(requestMethod);
    initializeProvider((event, payload) => this.#emit(event, payload));
  }

  on = <Event extends QbitProviderEvent>(event: Event, listener: QbitProviderListener<Event>): this => {
    this.#assertEvent(event, listener);
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener as AnyListener);
    return this;
  };

  removeListener = <Event extends QbitProviderEvent>(event: Event, listener: QbitProviderListener<Event>): this => {
    this.#assertEvent(event, listener);
    this.#listeners.get(event)?.delete(listener as AnyListener);
    return this;
  };

  requestAccounts = (): Promise<string[]> => this.#api.requestAccounts();
  getAccounts = (): Promise<string[]> => this.#api.getAccounts();
  getPublicKey = (): Promise<string> => this.#api.getPublicKey();
  getBalance = (): Promise<QbitBalance | null> => this.#api.getBalance();
  getNetwork = (): Promise<QbitNetwork> => this.#api.getNetwork();
  switchNetwork = (network: QbitNetwork): Promise<void> => this.#api.switchNetwork(network);
  getChain = (): Promise<QbitChain> => this.#api.getChain();
  switchChain = (chain: QbitChain): Promise<void> => this.#api.switchChain(chain);
  signMessage = (text: string): Promise<P2mrMessageProof> => this.#api.signMessage(text);
  verifyMessage = (address: string, text: string, proof: P2mrMessageProof): Promise<boolean> =>
    this.#api.verifyMessage(address, text, proof);
  signPsbt = (psbtHex: string, options: QbitSignPsbtOptions): Promise<string> => this.#api.signPsbt(psbtHex, options);
  signPsbts = (psbtHexs: string[], options: QbitSignPsbtOptions[]): Promise<string[]> =>
    this.#api.signPsbts(psbtHexs, options);
  pushPsbt = (psbtHex: string): Promise<string> => this.#api.pushPsbt(psbtHex);
  pushTx = (rawHex: string): Promise<string> => this.#api.pushTx(rawHex);
  sendQbit = (toAddress: string, satoshis: number, options?: QbitSendOptions): Promise<string> =>
    this.#api.sendQbit(toAddress, satoshis, options);
  disconnect = (): Promise<void> => this.#api.disconnect();

  #assertEvent(event: unknown, listener: unknown): void {
    if (!SUPPORTED_EVENTS.has(event as QbitProviderEvent)) {
      throw new TypeError(`Unsupported Qbit provider event: ${String(event)}`);
    }
    if (typeof listener !== 'function') {
      throw new TypeError('Qbit provider listener must be a function');
    }
  }

  #emit<Event extends QbitProviderEvent>(event: Event, payload: QbitProviderEventMap[Event]): void {
    const listeners = this.#listeners.get(event);
    if (!listeners) {
      return;
    }
    [...listeners].forEach((listener) => listener(payload as never));
  }
}
