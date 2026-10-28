import { keyBy } from 'lodash'
import { AddressFlagType, CHAINS, CHAINS_MAP, NETWORK_TYPES, normalizeChainType } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

declare global {
  const langLocales: Record<string, Record<'message', string>>
}

const format = (str: string, ...args: any[]) => {
  return args.reduce((m, n) => m.replace('_s_', n), str)
}

export { format }

const chainsDict = keyBy(CHAINS, 'serverId')
export const getChain = (chainId?: string) => {
  if (!chainId) {
    return null
  }
  return chainsDict[chainId]
}

// Check if address flag is enabled
export const checkAddressFlag = (currentFlag: number, flag: AddressFlagType): boolean => {
  return Boolean(currentFlag & flag)
}

export function getChainInfo(chainType: ChainType) {
  const normalizedChainType = normalizeChainType(chainType)
  const chain = CHAINS_MAP[normalizedChainType]!
  return {
    enum: normalizedChainType,
    name: chain.label,
    network: NETWORK_TYPES[chain.networkType]!.name,
  }
}

export const objToUint8Array = (obj: any) => {
  const arr: number[] = []
  for (const id in obj) {
    arr[parseInt(id)] = obj[id]
  }
  return Uint8Array.from(arr)
}
