import BroadcastChannelMessage from '@/shared/utils/message/broadcastChannelMessage';
import { EthereumRpcError, ethErrors, serializeError } from 'eth-rpc-errors';

import { MESSAGE_TYPE } from '@qbit/wallet-shared';

import { getProviderChannelName } from './providerState';
import PushEventHandlers from './pushEventHandlers';
import type { ProviderEventEmitter, ProviderRequestData } from './types';

const PUBLIC_METHODS = new Set([
  'requestAccounts',
  'getAccounts',
  'getPublicKey',
  'getBalance',
  'getNetwork',
  'switchNetwork',
  'getChain',
  'switchChain',
  'signMessage',
  'verifyMessage',
  'signPsbt',
  'signPsbts',
  'pushPsbt',
  'pushTx',
  'sendQbit',
  'disconnect'
]);

let qbitChannel: BroadcastChannelMessage | null = null;

export const log = (event: string, ...args: unknown[]) => {
  if (process.env.NODE_ENV !== 'production') {
    void event;
    void args;
  }
};

export function initializeProvider(emit: ProviderEventEmitter): void {
  if (qbitChannel) {
    throw new Error('Qbit provider is already initialized');
  }

  const pushEvents = new PushEventHandlers(emit);
  qbitChannel = new BroadcastChannelMessage(getProviderChannelName())
    .connect()
    .on(MESSAGE_TYPE.BCM_CHANNEL_TO_PAGE, (data) => handleBackgroundMessage(pushEvents, data));
}

export function handleBackgroundMessage(
  pushEvents: PushEventHandlers,
  message: { event?: unknown; data?: unknown } | null | undefined
): void {
  const { event, data } = message || {};
  log('[push event]', event, data);
  pushEvents.handle(event, data);
}

export async function requestMethod<Result>(data: ProviderRequestData): Promise<Result> {
  if (!data || typeof data.method !== 'string') {
    throw ethErrors.rpc.invalidRequest();
  }
  if (!PUBLIC_METHODS.has(data.method)) {
    throw ethErrors.rpc.methodNotFound();
  }
  if (!qbitChannel) {
    throw ethErrors.provider.disconnected();
  }

  log('[request]', data.method);
  return qbitChannel
    .request(data)
    .then((result) => {
      log('[request: success]', data.method);
      return result as Result;
    })
    .catch((error) => {
      const serialized = serializeError(error);
      log('[request: error]', data.method, serialized);
      throw new EthereumRpcError(serialized.code, serialized.message, serialized.data);
    });
}
