import type { P2mrMessageProof } from '@qbit-oss/protocol'
import type {
  ChainType,
  QbitBalance,
  QbitNetwork,
  QbitSendOptions,
  QbitSignPsbtOptions,
} from './types'

export type { P2mrMessageProof } from '@qbit-oss/protocol'

export interface QbitProviderEventMap {
  accountsChanged: string[]
  networkChanged: QbitNetwork
  chainChanged: ChainType
  disconnect: unknown
}

export type QbitProviderEvent = keyof QbitProviderEventMap
export type QbitProviderListener<Event extends QbitProviderEvent> = (
  payload: QbitProviderEventMap[Event]
) => void

/**
 * Qbit wallet provider interface
 */
export interface QbitProvider {
  getAccounts(): Promise<string[]>
  requestAccounts(): Promise<string[]>
  getPublicKey(): Promise<string>
  getBalance(): Promise<QbitBalance | null>
  getNetwork(): Promise<QbitNetwork>
  switchNetwork(network: QbitNetwork): Promise<void>
  getChain(): Promise<ChainType>
  switchChain(chain: ChainType): Promise<void>
  signMessage(message: string): Promise<P2mrMessageProof>
  verifyMessage(address: string, message: string, proof: P2mrMessageProof): Promise<boolean>
  signPsbt(psbt: string, options: QbitSignPsbtOptions): Promise<string>
  signPsbts(psbts: string[], options: QbitSignPsbtOptions[]): Promise<string[]>
  pushPsbt(psbt: string): Promise<string>
  pushTx(rawHex: string): Promise<string>
  sendQbit(address: string, amount: number, options?: QbitSendOptions): Promise<string>
  disconnect(): Promise<void>
  on<Event extends QbitProviderEvent>(event: Event, listener: QbitProviderListener<Event>): void
  removeListener<Event extends QbitProviderEvent>(
    event: Event,
    listener: QbitProviderListener<Event>
  ): void
}

/**
 * Global window extensions for wallet providers
 */
declare global {
  interface Window {
    qbit?: QbitProvider
  }
}

export {}
