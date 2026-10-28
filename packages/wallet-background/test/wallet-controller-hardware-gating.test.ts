import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AddressType, ChainType } from '@qbit/wallet-types'
import { WalletController } from '../src/controllers/wallet'
import { preferenceService } from '../src/services'

vi.mock('../src/services', () => ({
  keyringService: {
    addKeyring: vi.fn(),
    displayForKeyring: vi.fn(),
    keyrings: [] as any[],
  },
  preferenceService: {
    getChainType: vi.fn(() => ChainType.QBIT_MAINNET),
    setShowSafeNotice: vi.fn(),
  },
  walletApiService: {
    setEndpoint: vi.fn(),
  },
  sessionService: {
    broadcastEvent: vi.fn(),
  },
  contactBookService: {
    listAlias: vi.fn(() => []),
  },
  notificationService: {},
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

const sampleXpub =
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'

describe('WalletController hardware-wallet gating', () => {
  let controller: WalletController

  beforeEach(() => {
    vi.clearAllMocks()
    controller = new WalletController()
  })

  it.each([ChainType.QBIT_MAINNET, ChainType.QBIT_TESTNET4, ChainType.QBIT_REGTEST])(
    'refuses cold-wallet creation on %s',
    async chainType => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(chainType)
      await expect(
        controller.createKeyringWithColdWallet(sampleXpub, AddressType.P2WPKH)
      ).rejects.toThrow('hardware_wallet_not_supported')
    }
  )

  it.each([ChainType.QBIT_MAINNET, ChainType.QBIT_TESTNET4, ChainType.QBIT_REGTEST])(
    'refuses xpub account derivation on %s',
    async chainType => {
      vi.mocked(preferenceService.getChainType).mockReturnValue(chainType)
      await expect(
        controller.deriveAccountsFromXpub(sampleXpub, AddressType.P2WPKH)
      ).rejects.toThrow('hardware_wallet_not_supported')
    }
  )
})
