import { describe, expect, it, vi } from 'vitest'

import { UI_CONTROLLER_METHODS } from '../src/controllers/ui-access'
import { WalletController } from '../src/controllers/wallet'

vi.mock('../src/services', () => ({
  keyringService: { keyrings: [] as any[] },
  preferenceService: {},
  sessionService: {},
  contactBookService: {},
  permissionService: {},
}))

vi.mock('../src/services/approval', () => ({
  default: {},
}))

// No hardware or cold signer supports qbit's SLH-DSA signatures (D5), so the
// wallet offers no way to add one; KeyringService.addKeyring refuses a
// ColdWalletKeyring as well.
describe('WalletController hardware-wallet gating', () => {
  it.each(['createKeyringWithColdWallet', 'deriveAccountsFromXpub'])(
    'has no %s method, and the UI port allows none',
    method => {
      expect(method in new WalletController()).toBe(false)
      expect(UI_CONTROLLER_METHODS as readonly string[]).not.toContain(method)
    }
  )
})
