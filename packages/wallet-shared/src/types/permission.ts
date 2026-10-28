import { ChainType } from '@qbit/wallet-types'

export interface ConnectedSite {
  origin: string
  icon: string
  name: string
  chain: ChainType
  e?: number
  isSigned: boolean
  isTop: boolean
  order?: number
  isConnected: boolean
  allowQuickMultiSign?: boolean
}
