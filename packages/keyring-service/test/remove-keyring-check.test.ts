import { describe, expect, it, vi } from 'vitest'

import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import { KeyringType } from '../src/types'
import type { Encryptor } from '../src/types'

// removeKeyring's check runs where no other change to the wallets can land
// before the slot is emptied, so a decision it makes, such as that a usable
// wallet stays, still holds when the wallet goes.

const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const THIRD_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const HD_PATH = "m/84'/0'/0'/0"
const PASSWORD = 'password'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, structuredClone(value))
  }
}

class JsonEncryptor implements Encryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }
}

const testLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** An unlocked service holding one wallet for each phrase, and its storage. */
async function serviceWithWallets(...mnemonics: string[]) {
  const storage = new MemoryStorage()
  const service = new KeyringService()
  await service.init({
    storage: storage as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger,
    t: (key: string) => key,
  })
  await service.boot(PASSWORD)
  for (const mnemonic of mnemonics) {
    await service.createKeyringWithMnemonics(mnemonic, HD_PATH, '', AddressType.P2WPKH, 1)
  }
  return { service, storage }
}

const slots = (service: KeyringService) => service.keyrings.map(keyring => keyring.type)

/** The wallets the saved vault holds, as the next unlock loads them. */
async function savedSlots(service: KeyringService) {
  await service.setLocked()
  await service.submitPassword(PASSWORD)
  return slots(service)
}

/** A check that waits until it is let go, and says when it has started. */
function heldCheck() {
  const started = deferred()
  const gate = deferred()
  const beforeRemove = vi.fn(async () => {
    started.resolve()
    await gate.promise
  })
  return { beforeRemove, started: started.promise, release: gate.resolve }
}

describe('removeKeyring with a check before the wallet goes', () => {
  it('removes the wallet once the check passes', async () => {
    const { service } = await serviceWithWallets(MNEMONIC, OTHER_MNEMONIC)
    const beforeRemove = vi.fn()

    await service.removeKeyring(0, { beforeRemove })

    expect(beforeRemove).toHaveBeenCalledTimes(1)
    expect(slots(service)).toEqual([KeyringType.Empty, KeyringType.HdKeyring])
    expect(await savedSlots(service)).toEqual([KeyringType.Empty, KeyringType.HdKeyring])
  })

  it('removes nothing, and passes the error on, when the check throws', async () => {
    const { service, storage } = await serviceWithWallets(MNEMONIC, OTHER_MNEMONIC)
    const saved = storage.values.get('keyringState')

    await expect(
      service.removeKeyring(0, {
        beforeRemove: async () => {
          throw new Error('a usable wallet must stay')
        },
      })
    ).rejects.toThrow('a usable wallet must stay')

    expect(slots(service)).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
    expect(storage.values.get('keyringState')).toEqual(saved)
    const displayed = await service.getAllDisplayedKeyrings()
    expect(displayed.map(keyring => keyring.type)).toEqual([
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
    ])
    expect(await savedSlots(service)).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
  })

  it('lets no wallet be added until the wallet is gone', async () => {
    const { service } = await serviceWithWallets(MNEMONIC, OTHER_MNEMONIC)
    const check = heldCheck()
    const removing = service.removeKeyring(0, { beforeRemove: check.beforeRemove })
    await check.started

    const adding = service.createKeyringWithMnemonics(
      THIRD_MNEMONIC,
      HD_PATH,
      '',
      AddressType.P2WPKH,
      1
    )
    // The addition waits while the check runs.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(slots(service)).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
    check.release()

    await removing
    await adding
    expect(slots(service)).toEqual([
      KeyringType.Empty,
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
    ])
    expect(await savedSlots(service)).toEqual([
      KeyringType.Empty,
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
    ])
  })

  it('removes nothing when the wallet locks while the check runs', async () => {
    const { service } = await serviceWithWallets(MNEMONIC, OTHER_MNEMONIC)
    const check = heldCheck()
    const removing = service.removeKeyring(0, { beforeRemove: check.beforeRemove })
    await check.started

    await service.setLocked()
    check.release()

    await expect(removing).rejects.toThrow('you_need_to_unlock_wallet_first')
    expect(service.keyrings).toEqual([])
    await service.submitPassword(PASSWORD)
    expect(slots(service)).toEqual([KeyringType.HdKeyring, KeyringType.HdKeyring])
  })
})
