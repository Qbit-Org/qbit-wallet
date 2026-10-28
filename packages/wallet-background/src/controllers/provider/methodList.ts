import type { P2mrMessageProof } from '@qbit/wallet-shared'
import type { ChainType } from '@qbit/wallet-types'

export const PUBLIC_PROVIDER_METHODS = [
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
  'disconnect',
] as const

export const INTERNAL_PROVIDER_METHODS = ['tabCheckin'] as const

export type PublicProviderMethod = (typeof PUBLIC_PROVIDER_METHODS)[number]
export type InternalProviderMethod = (typeof INTERNAL_PROVIDER_METHODS)[number]

export type ProviderMethodList = {
  requestAccounts: undefined
  getAccounts: undefined
  getPublicKey: undefined
  getBalance: undefined
  getNetwork: undefined
  switchNetwork: { network: 'mainnet' | 'testnet4' | 'regtest' }
  getChain: undefined
  switchChain: { chain: ChainType }
  signMessage: { text: string }
  verifyMessage: { address: string; text: string; proof: P2mrMessageProof }
  signPsbt: {
    psbtHex: string
    options: { chain: ChainType; autoFinalized?: boolean }
  }
  signPsbts: {
    psbtHexs: string[]
    options: { chain: ChainType; autoFinalized?: boolean }[]
  }
  pushPsbt: { psbtHex: string }
  pushTx: { rawtx: string }
  sendQbit: {
    sendQbitParams: {
      toAddress: string
      satoshis: number
      feeRate?: number
      memo?: string
      memos?: string[]
    }
  }
  disconnect: undefined
}

export type ProviderMethods = keyof ProviderMethodList

export type ProviderMethodArgs<T extends ProviderMethods = ProviderMethods> =
  T extends ProviderMethods
    ? ProviderMethodList[T] extends undefined
      ? { method: T }
      : { method: T; params: ProviderMethodList[T] }
    : never

export type ProviderRequestEnvelope =
  | { source: 'page'; data: ProviderMethodArgs }
  | {
      source: 'content'
      data: {
        method: 'tabCheckin'
        params: { name?: string; icon?: string; activeDocument?: boolean }
      }
    }

export function isPublicProviderMethod(value: unknown): value is PublicProviderMethod {
  return typeof value === 'string' && (PUBLIC_PROVIDER_METHODS as readonly string[]).includes(value)
}

export function isInternalProviderMethod(value: unknown): value is InternalProviderMethod {
  return (
    typeof value === 'string' && (INTERNAL_PROVIDER_METHODS as readonly string[]).includes(value)
  )
}
