import type { P2mrMessageProof } from '@qbit/wallet-shared';

export type { P2mrMessageProof } from '@qbit/wallet-shared';

export const QBIT_CHAINS = ['QBIT_MAINNET', 'QBIT_TESTNET4', 'QBIT_REGTEST'] as const;
export type QbitChain = (typeof QBIT_CHAINS)[number];

export const QBIT_NETWORKS = ['mainnet', 'testnet4', 'regtest'] as const;
export type QbitNetwork = (typeof QBIT_NETWORKS)[number];

export interface QbitBalance {
  confirmed: number;
  unconfirmed: number;
  total: number;
}

export interface QbitSignPsbtOptions {
  chain: QbitChain;
  autoFinalized?: boolean;
}

export interface QbitSendOptions {
  feeRate?: number;
  memo?: string;
  memos?: string[];
}

export interface QbitProviderEventMap {
  accountsChanged: string[];
  networkChanged: QbitNetwork;
  chainChanged: QbitChain;
  disconnect: unknown;
}

export type QbitProviderEvent = keyof QbitProviderEventMap;
export type QbitProviderListener<Event extends QbitProviderEvent> = (payload: QbitProviderEventMap[Event]) => void;

export interface ProviderRequestData {
  method: string;
  params?: unknown;
}

export type ProviderRequest = <Result>(data: ProviderRequestData) => Promise<Result>;
export type ProviderEventEmitter = <Event extends QbitProviderEvent>(
  event: Event,
  payload: QbitProviderEventMap[Event]
) => void;

export function isQbitChain(value: unknown): value is QbitChain {
  return typeof value === 'string' && (QBIT_CHAINS as readonly string[]).includes(value);
}

export function isQbitNetwork(value: unknown): value is QbitNetwork {
  return typeof value === 'string' && (QBIT_NETWORKS as readonly string[]).includes(value);
}

export function isP2mrMessageProof(value: unknown): value is P2mrMessageProof {
  return typeof value === 'object' && value !== null && (value as P2mrMessageProof).type === 'p2mr-message';
}
