import { describe, expect, it, vi } from 'vitest'

import { AddressType } from '@qbit/wallet-types'
import { KeyringService } from '../src/keyring-service'
import { KeyringType } from '../src/types'
import type { Encryptor, Keyring } from '../src/types'

// The shown wallets are kept for the reads that follow, until the keyrings
// change. A read that a change overtakes, because it started before the change
// and settled after it, must not keep the wallets as they were: every later
// read would return them until the next change.

const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const HD_PATH = "m/84'/0'/0'/0"

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
    this.values.set(key, value)
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

/** An unlocked service holding one wallet for each phrase, one account each. */
async function serviceWithWallets(...mnemonics: string[]) {
  const service = new KeyringService()
  await service.init({
    storage: new MemoryStorage() as any,
    encryptor: new JsonEncryptor(),
    logger: testLogger,
    t: (key: string) => key,
  })
  await service.boot('password')
  for (const mnemonic of mnemonics) {
    await service.createKeyringWithMnemonics(mnemonic, HD_PATH, '', AddressType.P2WPKH, 1)
  }
  return service
}

/**
 * Starts a read of the shown wallets that waits, once it has read `keyring`'s
 * accounts, until it is released: it reads the wallets as they are now and
 * settles only after whatever happens meanwhile. `resetCache` is passed on.
 */
function startHeldRead(service: KeyringService, keyring: Keyring, resetCache?: boolean) {
  const accounts = keyring.getAccounts.bind(keyring)
  const gate = deferred()
  const accountsRead = vi.spyOn(keyring, 'getAccounts').mockImplementationOnce(async () => {
    const listed = await accounts()
    await gate.promise
    return listed
  })
  const reading = service.getAllDisplayedKeyrings(resetCache)
  // The read computes the wallets rather than return a list kept earlier.
  expect(accountsRead).toHaveBeenCalledTimes(1)
  return {
    finish() {
      gate.resolve()
      return reading
    },
  }
}

const accountCounts = (displayed: { accounts: unknown[] }[]) =>
  displayed.map(keyring => keyring.accounts.length)

describe('a read of the shown wallets that a change overtakes', () => {
  it('keeps nothing when an account is added while it reads', async () => {
    const service = await serviceWithWallets(MNEMONIC)
    const [wallet] = service.keyrings
    const otherWindow = startHeldRead(service, wallet!)

    await service.addNewAccount(wallet!)
    // A read after the addition, while the earlier one is still under way.
    expect(accountCounts(await service.getAllDisplayedKeyrings())).toEqual([2])
    // The earlier read answers with the wallets as it read them...
    expect(accountCounts(await otherWindow.finish())).toEqual([1])

    // ...and the reads after it get the account.
    expect(accountCounts(await service.getAllDisplayedKeyrings())).toEqual([2])
  })

  it('keeps nothing when a wallet is removed while it reads', async () => {
    const service = await serviceWithWallets(MNEMONIC, OTHER_MNEMONIC)
    const otherWindow = startHeldRead(service, service.keyrings[1]!)

    await service.removeKeyring(0)
    const earlier = await otherWindow.finish()
    expect(earlier.map(keyring => keyring.type)).toEqual([
      KeyringType.HdKeyring,
      KeyringType.HdKeyring,
    ])

    const displayed = await service.getAllDisplayedKeyrings()
    expect(displayed.map(keyring => keyring.type)).toEqual([KeyringType.Empty, KeyringType.HdKeyring])
  })

  it('keeps nothing when a wallet is added while it reads', async () => {
    const service = await serviceWithWallets(MNEMONIC)
    const otherWindow = startHeldRead(service, service.keyrings[0]!)

    await service.createKeyringWithMnemonics(OTHER_MNEMONIC, HD_PATH, '', AddressType.P2WPKH, 1)
    expect(await otherWindow.finish()).toHaveLength(1)

    const displayed = await service.getAllDisplayedKeyrings()
    expect(displayed.map(keyring => keyring.index)).toEqual([0, 1])
  })

  it('keeps nothing when the wallet locks while it reads', async () => {
    const service = await serviceWithWallets(MNEMONIC)
    const otherWindow = startHeldRead(service, service.keyrings[0]!)

    await service.setLocked()
    expect(await otherWindow.finish()).toHaveLength(1)

    await expect(service.getAllDisplayedKeyrings()).resolves.toEqual([])
    await service.submitPassword('password')
    expect(accountCounts(await service.getAllDisplayedKeyrings())).toEqual([1])
  })

  it('keeps nothing, as a forced read, when an account is added while it reads', async () => {
    const service = await serviceWithWallets(MNEMONIC)
    const [wallet] = service.keyrings
    // A list is kept: the forced read computes the wallets all the same.
    expect(accountCounts(await service.getAllDisplayedKeyrings())).toEqual([1])
    const afresh = startHeldRead(service, wallet!, true)

    await service.addNewAccount(wallet!)
    expect(accountCounts(await afresh.finish())).toEqual([1])

    expect(accountCounts(await service.getAllDisplayedKeyrings())).toEqual([2])
  })
})

describe('reads of the shown wallets that overlap', () => {
  it('never lets an earlier read replace the list a later read kept', async () => {
    const service = await serviceWithWallets(MNEMONIC)
    let network = 'regtest'
    service.setActiveQbitNetworkResolver(() => network)
    // One window reads the wallets for regtest, and the network switches to
    // testnet4 while it reads; another window then reads them for testnet4.
    const earlier = startHeldRead(service, service.keyrings[0]!)
    network = 'testnet4'
    const later = await service.getAllDisplayedKeyrings()
    await earlier.finish()

    // The reads for testnet4 keep getting the later read's list.
    await expect(service.getAllDisplayedKeyrings()).resolves.toBe(later)
  })
})
