import type {
  P2mrMessageProof,
  ProviderRequest,
  QbitBalance,
  QbitChain,
  QbitNetwork,
  QbitSendOptions,
  QbitSignPsbtOptions
} from './types';
import { isQbitChain, isQbitNetwork } from './types';

function assertSigningOptions(options: QbitSignPsbtOptions | undefined): asserts options is QbitSignPsbtOptions {
  if (!options || !isQbitChain(options.chain)) {
    throw new TypeError('Qbit PSBT signing requires a supported chain');
  }
}

export class QbitAPIMethods {
  readonly #request: ProviderRequest;

  constructor(request: ProviderRequest) {
    this.#request = request;
  }

  requestAccounts = async (): Promise<string[]> => {
    return this.#request({
      method: 'requestAccounts'
    });
  };

  disconnect = async (): Promise<void> => {
    return this.#request({
      method: 'disconnect'
    });
  };

  getNetwork = async (): Promise<QbitNetwork> => {
    return this.#request({
      method: 'getNetwork'
    });
  };

  switchNetwork = async (network: QbitNetwork): Promise<void> => {
    if (!isQbitNetwork(network)) {
      throw new TypeError('Unsupported Qbit network');
    }
    return this.#request({
      method: 'switchNetwork',
      params: {
        network
      }
    });
  };

  getChain = async (): Promise<QbitChain> => {
    return this.#request({
      method: 'getChain'
    });
  };

  switchChain = async (chain: QbitChain): Promise<void> => {
    if (!isQbitChain(chain)) {
      throw new TypeError('Unsupported Qbit chain');
    }
    return this.#request({
      method: 'switchChain',
      params: {
        chain
      }
    });
  };

  getAccounts = async (): Promise<string[]> => {
    return this.#request({
      method: 'getAccounts'
    });
  };

  getPublicKey = async (): Promise<string> => {
    return this.#request({
      method: 'getPublicKey'
    });
  };

  getBalance = async (): Promise<QbitBalance | null> => {
    return this.#request({
      method: 'getBalance'
    });
  };

  signMessage = async (text: string): Promise<P2mrMessageProof> => {
    return this.#request({
      method: 'signMessage',
      params: { text }
    });
  };

  verifyMessage = async (address: string, text: string, proof: P2mrMessageProof): Promise<boolean> => {
    return this.#request({
      method: 'verifyMessage',
      params: {
        address,
        text,
        proof
      }
    });
  };

  sendQbit = async (toAddress: string, satoshis: number, options?: QbitSendOptions): Promise<string> => {
    return this.#request({
      method: 'sendQbit',
      params: {
        sendQbitParams: {
          toAddress,
          satoshis,
          feeRate: options?.feeRate,
          memo: options?.memo,
          memos: options?.memos
        }
      }
    });
  };

  pushTx = async (rawtx: string): Promise<string> => {
    return this.#request({
      method: 'pushTx',
      params: {
        rawtx
      }
    });
  };

  signPsbt = async (psbtHex: string, options: QbitSignPsbtOptions): Promise<string> => {
    assertSigningOptions(options);
    return this.#request({
      method: 'signPsbt',
      params: {
        psbtHex,
        options
      }
    });
  };

  signPsbts = async (psbtHexs: string[], options: QbitSignPsbtOptions[]): Promise<string[]> => {
    if (!Array.isArray(options) || options.length !== psbtHexs.length) {
      throw new TypeError('Qbit batch PSBT signing requires one options entry per PSBT');
    }
    options.forEach(assertSigningOptions);
    return this.#request({
      method: 'signPsbts',
      params: {
        psbtHexs,
        options
      }
    });
  };

  pushPsbt = async (psbtHex: string): Promise<string> => {
    return this.#request({
      method: 'pushPsbt',
      params: {
        psbtHex
      }
    });
  };
}
