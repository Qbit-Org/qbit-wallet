import { beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import {
  AccountSignMethod,
  canCreateQbitSendRequest,
  getAccountCapabilities,
} from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import { keyringService, preferenceService } from '../src/services'

// The cold-wallet QR flow is gone, but a vault an earlier release wrote may
// still hold a cold-wallet entry. It must keep unlocking, list its account,
// and offer that account no way to sign. Real keyring and preference
// services, over memory storage.

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, value)
  }
}

class JsonEncryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

class DiskAdapter {
  disk = new Map<string, string>()

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    return { ...structuredClone(template), ...(await this.get(name)) }
  }

  async get(key: string): Promise<any> {
    const raw = this.disk.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: any): Promise<void> {
    this.disk.set(key, JSON.stringify(value))
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const PASSWORD = 'password'
// A Qbit mainnet address nobody holds the key to.
const WATCH_ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'
// The public key of the secp256k1 point G, not anyone's wallet.
const COLD_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
// A vault entry as ColdWalletKeyring.serialize() has written it since 1.0.5.
const COLD_WALLET_ENTRY = {
  type: 'Cold Wallet',
  data: {
    xpub: 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz',
    addresses: [],
    connectionType: 'QR',
    hdPath: "m/84'/0'/0'/0",
    publicKeys: [COLD_PUBKEY],
  },
  addressType: AddressType.P2WPKH,
}

let storage: MemoryStorage
let wallet: WalletController

const initKeyringService = () =>
  keyringService.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger,
    t: (key: string) => key,
    eventBus: { emit: vi.fn() } as any,
  })

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  await preferenceService.init({ storage: new DiskAdapter() as any, logger })
  storage = new MemoryStorage()
  await initKeyringService()
  await keyringService.boot(PASSWORD)
  wallet = new WalletController()

  // A watched address beside the cold wallet, then the cold-wallet entry
  // written into the saved vault, and a restart.
  await wallet.createKeyringWithAddress(WATCH_ADDRESS)
  const state = storage.values.get('keyringState')
  const entries = await new JsonEncryptor().decrypt(PASSWORD, state.vault)
  storage.values.set('keyringState', {
    ...state,
    vault: await new JsonEncryptor().encrypt(PASSWORD, [...entries, COLD_WALLET_ENTRY]),
  })
  await keyringService.setLocked()
  await initKeyringService()
})

describe('a vault that holds a cold-wallet entry', () => {
  it('unlocks and lists the cold wallet with its account', async () => {
    await keyringService.submitPassword(PASSWORD)

    expect(keyringService.keyrings.map(keyring => keyring.type)).toEqual([
      KeyringType.WatchAddressKeyring,
      KeyringType.ColdWalletKeyring,
    ])
    const keyrings = await wallet.getKeyrings()
    expect(keyrings.map(keyring => keyring.type)).toEqual([
      KeyringType.WatchAddressKeyring,
      KeyringType.ColdWalletKeyring,
    ])
    const cold = keyrings[1]!
    expect(cold.accounts).toHaveLength(1)
    expect(cold.accounts[0]!.pubkey).toBe(COLD_PUBKEY)
    expect(cold.accounts[0]!.address).not.toBe('')
  })

  it('keeps the entry unchanged through a later vault write', async () => {
    await keyringService.submitPassword(PASSWORD)

    // A password change re-encrypts and saves every entry.
    await keyringService.changePassword(PASSWORD, 'new password')

    const saved = await new JsonEncryptor().decrypt(
      'new password',
      storage.values.get('keyringState').vault
    )
    expect(saved.find((entry: any) => entry.type === 'Cold Wallet')).toEqual(COLD_WALLET_ENTRY)
  })

  it('gives its account no way to sign', async () => {
    await keyringService.submitPassword(PASSWORD)
    const cold = (await wallet.getKeyrings())[1]!
    await wallet.changeKeyring(cold)

    const account = preferenceService.getCurrentAccount()
    expect(account?.type).toBe(KeyringType.ColdWalletKeyring)
    expect(account?.p2mr).toBeUndefined()
    expect(getAccountCapabilities(account).signMethod).toBe(AccountSignMethod.ColdWallet)
    expect(canCreateQbitSendRequest(account)).toBe(false)
    await expect(wallet.preflightP2mrMessageSigning(['hello'])).rejects.toThrow('not_supported')
  })
})
