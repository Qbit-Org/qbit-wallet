import type { ProviderEventEmitter, QbitChain, QbitNetwork } from './types';
import { isQbitChain, isQbitNetwork } from './types';

class PushEventHandlers {
  readonly #emit: ProviderEventEmitter;

  constructor(emit: ProviderEventEmitter) {
    this.#emit = emit;
  }

  handle(event: unknown, data: unknown): void {
    switch (event) {
      case 'accountsChanged':
        if (Array.isArray(data) && data.every((account) => typeof account === 'string')) {
          this.#emit('accountsChanged', [...data]);
        }
        return;
      case 'networkChanged': {
        const network = this.#network(data);
        if (network) {
          this.#emit('networkChanged', network);
        }
        return;
      }
      case 'chainChanged': {
        const chain = this.#chain(data);
        if (chain) {
          this.#emit('chainChanged', chain);
        }
        return;
      }
      case 'disconnect':
        this.#emit('disconnect', data);
        return;
      default:
        return;
    }
  }

  #network(data: unknown): QbitNetwork | undefined {
    const value =
      typeof data === 'object' && data !== null && 'network' in data ? (data as { network: unknown }).network : data;
    return isQbitNetwork(value) ? value : undefined;
  }

  #chain(data: unknown): QbitChain | undefined {
    const value = typeof data === 'object' && data !== null && 'enum' in data ? (data as { enum: unknown }).enum : data;
    return isQbitChain(value) ? value : undefined;
  }
}

export default PushEventHandlers;
