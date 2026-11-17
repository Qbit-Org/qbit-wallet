import { describe, expect, it, vi } from 'vitest'

import { BaseProxyStorageAdapter } from '@qbit/wallet-storage'
import { ChainType } from '@qbit/wallet-types'
import { PreferenceService } from '../src/preference-service'
import {
  RELEASES,
  readReleaseStorage,
} from '../../../tests/fixtures/release-storage/release-storage'

// The records a wallet removal keeps of the send plans it ends (#216), in
// the preferences beside the pending reset mark: written before the removal
// changes anything, forgotten once nothing of those plans is left. Every
// entry carries its version. An entry this version cannot read is kept as
// it is stored and named as unreadable, with the accounts it names; nothing
// written here drops it or writes over it.

// chrome.storage.local hands out copies, and keeps copies of what it is given.
class DumpStorage extends BaseProxyStorageAdapter {
  refuse = false

  constructor(readonly values: Record<string, unknown> = {}) {
    super()
  }

  async get(key: string): Promise<any> {
    return structuredClone(this.values[key])
  }

  async set(key: string, value: any): Promise<void> {
    if (this.refuse) throw new Error('storage unavailable')
    this.values[key] = structuredClone(value)
  }
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }

/** The preferences `storage` holds, loaded as the background loads them as it starts. */
async function load(storage: DumpStorage): Promise<PreferenceService> {
  const service = new PreferenceService()
  await service.init({ storage, logger })
  return service
}

/** The preferences `storage` holds, read by a background that starts again, over a storage of its own. */
function restart(storage: DumpStorage): Promise<PreferenceService> {
  return load(new DumpStorage(storage.values))
}

/** The removal records `storage` holds. */
function stored(storage: DumpStorage): unknown {
  return (storage.values['preference'] as Record<string, unknown> | undefined)?.qbitSendPlanRemovals
}

const WALLET = { index: 2, type: 'Qbit HD Key Tree' }
const ACCOUNTS = [
  { chain: ChainType.QBIT_MAINNET, address: 'qb1zmainnetaddress' },
  { chain: ChainType.QBIT_TESTNET4, address: 'tq1ztestnetaddress' },
]
const NONE = { records: [], unreadable: { count: 0, accounts: [] } }

describe('preferences stored before removal records existed', () => {
  it.each(RELEASES)('read as no record when %s stored them', async release => {
    const dump = readReleaseStorage(release)
    expect(dump.storage['preference']).not.toHaveProperty('qbitSendPlanRemovals')
    const service = await load(new DumpStorage(dump.storage))
    expect(service.getQbitSendPlanRemovals()).toEqual(NONE)
  })

  it('read as no record in a new store', async () => {
    expect((await load(new DumpStorage())).getQbitSendPlanRemovals()).toEqual(NONE)
  })
})

describe('a removal record', () => {
  it('is on disk, of version 1 and under a new random id, when it is stored, and reads back after a restart', async () => {
    const storage = new DumpStorage()
    const service = await load(storage)
    const record = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)

    expect(record).toEqual({
      version: 1,
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      wallet: WALLET,
      accounts: ACCOUNTS,
    })
    expect(stored(storage)).toEqual([record])
    expect((await restart(storage)).getQbitSendPlanRemovals()).toEqual({
      ...NONE,
      records: [record],
    })
    const other = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    expect(other.id).not.toBe(record.id)
  })

  it('is not stored when storage refuses it, and every record stored before stays', async () => {
    const storage = new DumpStorage()
    const service = await load(storage)
    const first = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    storage.refuse = true

    await expect(
      service.addQbitSendPlanRemoval({ index: 3, type: 'Qbit HD Key Tree' }, ACCOUNTS)
    ).rejects.toThrow()

    expect(service.getQbitSendPlanRemovals().records).toEqual([first])
    expect(stored(storage)).toEqual([first])
  })

  it.each([
    ['a negative slot', { index: -1, type: 'Qbit HD Key Tree' }, ACCOUNTS],
    ['a slot that is not a whole number', { index: 1.5, type: 'Qbit HD Key Tree' }, ACCOUNTS],
    ['no keyring type', { index: 0, type: '' }, ACCOUNTS],
    [
      'an account on a network no plan is on',
      WALLET,
      [{ chain: ChainType.BITCOIN_MAINNET, address: 'bc1qaddress' }],
    ],
    ['an account without an address', WALLET, [{ chain: ChainType.QBIT_MAINNET, address: '' }]],
  ])('is refused, nothing written, when it names %s', async (_label, wallet, accounts) => {
    const storage = new DumpStorage()
    const service = await load(storage)
    await expect(
      service.addQbitSendPlanRemoval(wallet as never, accounts as never)
    ).rejects.toThrow('A wallet removal record names a wallet slot, its type and Qbit accounts')
    expect(stored(storage)).toBeUndefined()
    expect(storage.values['preference']).not.toHaveProperty('qbitSendPlanRemovals')
  })

  it('is forgotten on disk, the others staying, and the setting goes once it holds none', async () => {
    const storage = new DumpStorage()
    const service = await load(storage)
    const first = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    const second = await service.addQbitSendPlanRemoval(
      { index: 3, type: 'Qbit HD Key Tree' },
      ACCOUNTS
    )

    await service.forgetQbitSendPlanRemoval(first.id)
    expect(stored(storage)).toEqual([second])
    expect((await restart(storage)).getQbitSendPlanRemovals().records).toEqual([second])

    await service.forgetQbitSendPlanRemoval(second.id)
    expect(service.getQbitSendPlanRemovals()).toEqual(NONE)
    // chrome.storage.local drops a key whose value is undefined.
    expect(stored(storage)).toBeUndefined()
  })

  it('stays when storage refuses to forget it', async () => {
    const storage = new DumpStorage()
    const service = await load(storage)
    const record = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    storage.refuse = true

    await expect(service.forgetQbitSendPlanRemoval(record.id)).rejects.toThrow()

    expect(service.getQbitSendPlanRemovals().records).toEqual([record])
    expect(stored(storage)).toEqual([record])
  })

  it('makes one write of its own for a forget storage refuses, logs nothing itself and keeps the record; the storage adapter then saves the whole store on its own a second later, and logs that write failing too', async () => {
    const storage = new DumpStorage()
    const errors: unknown[] = []
    const service = new PreferenceService()
    await service.init({
      storage,
      logger: { ...logger, error: (...args: unknown[]) => errors.push(args) },
    })
    const record = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    storage.refuse = true
    const writes = vi.spyOn(storage, 'set')
    const adapterErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      await expect(service.forgetQbitSendPlanRemoval(record.id)).rejects.toThrow(
        'storage unavailable'
      )

      expect(writes).toHaveBeenCalledTimes(1)
      expect(errors).toEqual([])
      expect(adapterErrors).not.toHaveBeenCalled()
      expect(service.getQbitSendPlanRemovals().records).toEqual([record])
      expect(stored(storage)).toEqual([record])

      // The adapter's deferred save of the whole store, as after any change.
      await vi.advanceTimersByTimeAsync(999)
      expect(writes).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(writes).toHaveBeenCalledTimes(2)
      expect(adapterErrors).toHaveBeenCalledTimes(1)
      expect(errors).toEqual([])
      expect(stored(storage)).toEqual([record])
    } finally {
      vi.useRealTimers()
      adapterErrors.mockRestore()
    }
  })

  it('writes nothing to forget an id none is stored under', async () => {
    const storage = new DumpStorage()
    const service = await load(storage)
    const record = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    storage.refuse = true

    await expect(service.forgetQbitSendPlanRemoval('ff'.repeat(16))).resolves.toBeUndefined()
    expect(stored(storage)).toEqual([record])
  })

  it('keeps every change asked for at once: each reads the list the one before left', async () => {
    const storage = new DumpStorage()
    const service = await load(storage)
    const first = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)

    const [second, , third] = await Promise.all([
      service.addQbitSendPlanRemoval({ index: 3, type: 'Qbit HD Key Tree' }, ACCOUNTS),
      service.forgetQbitSendPlanRemoval(first.id),
      service.addQbitSendPlanRemoval({ index: 4, type: 'Qbit HD Key Tree' }, ACCOUNTS),
    ])

    expect(stored(storage)).toEqual([second, third])
    expect((await restart(storage)).getQbitSendPlanRemovals().records).toEqual([second, third])
  })
})

describe('removal records this version cannot read', () => {
  const ACCOUNT = { chain: ChainType.QBIT_MAINNET, address: 'qb1zaccountnamed' }
  const valid = { version: 1, id: 'a1'.repeat(16), wallet: WALLET, accounts: [ACCOUNT] }

  it.each([
    ['of a later version', { ...valid, version: 2, slot: 'keyring_2' }, [ACCOUNT]],
    ['without a version', { id: valid.id, wallet: WALLET, accounts: [ACCOUNT] }, [ACCOUNT]],
    ['with an id this version would not make', { ...valid, id: 'not an id' }, [ACCOUNT]],
    ['with a negative slot', { ...valid, wallet: { index: -1, type: WALLET.type } }, [ACCOUNT]],
    ['without a keyring type', { ...valid, wallet: { index: 2 } }, [ACCOUNT]],
    [
      'naming an account on an unknown network',
      { ...valid, accounts: [ACCOUNT, { chain: 'ELSEWHERE', address: 'x' }] },
      [ACCOUNT],
    ],
    [
      'naming an account without an address',
      { ...valid, accounts: [ACCOUNT, { chain: ChainType.QBIT_MAINNET, address: '' }] },
      [ACCOUNT],
    ],
    ['without a list of accounts', { ...valid, accounts: ACCOUNT }, []],
    ['that is not an object', 'a removal', []],
    ['that is null', null, []],
  ])(
    'are named as unreadable, with the accounts they name, when %s, and kept as they are',
    async (_label, entry, accounts) => {
      const storage = new DumpStorage({
        preference: { locale: 'en', qbitSendPlanRemovals: [entry] },
      })
      const service = await load(storage)

      expect(service.getQbitSendPlanRemovals()).toEqual({
        records: [],
        unreadable: { count: 1, accounts },
      })
      // A change made here keeps the entry exactly as stored.
      const record = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
      expect(stored(storage)).toEqual([entry, record])
      await service.forgetQbitSendPlanRemoval(record.id)
      expect(stored(storage)).toEqual([entry])
    }
  )

  it('name a second entry under an id read already as unreadable', async () => {
    const twin = { ...valid, accounts: [{ chain: ChainType.QBIT_TESTNET4, address: 'tq1ztwin' }] }
    const service = await load(
      new DumpStorage({ preference: { qbitSendPlanRemovals: [valid, twin] } })
    )
    expect(service.getQbitSendPlanRemovals()).toEqual({
      records: [valid],
      unreadable: { count: 1, accounts: twin.accounts },
    })
  })

  it('keep a value that is not a list, as one entry, beside a record stored here', async () => {
    const storage = new DumpStorage({
      preference: { qbitSendPlanRemovals: { version: 3, removals: [] } },
    })
    const service = await load(storage)
    expect(service.getQbitSendPlanRemovals()).toEqual({
      records: [],
      unreadable: { count: 1, accounts: [] },
    })

    const record = await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    expect(stored(storage)).toEqual([{ version: 3, removals: [] }, record])
  })

  it('read what a version-1 record stores beside fields it does not know, and keep those fields', async () => {
    const extended = { ...valid, note: 'a field this version does not know' }
    const storage = new DumpStorage({ preference: { qbitSendPlanRemovals: [extended] } })
    const service = await load(storage)
    expect(service.getQbitSendPlanRemovals().records).toEqual([valid])

    await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)
    expect((stored(storage) as unknown[])[0]).toEqual(extended)
  })
})

describe('the preference loader with removal records stored', () => {
  // The loader (createPersistentProxy and validateAndFixStore) is the one the
  // previous release has: it keeps every stored key, the ones it does not
  // know included, and saves them back with every change.
  it('loads every other preference as saved, keeps the records, and saves them back unchanged', async () => {
    const records = [
      { version: 1, id: 'a1'.repeat(16), wallet: WALLET, accounts: ACCOUNTS },
      { version: 2, id: 'b2'.repeat(16), future: true },
    ]
    const dump = readReleaseStorage(RELEASES[RELEASES.length - 1]!)
    const saved = {
      ...(dump.storage['preference'] as Record<string, unknown>),
      qbitSendPlanRemovals: records,
    }
    const storage = new DumpStorage({ ...dump.storage, preference: structuredClone(saved) })
    const service = await load(storage)

    expect(service.getChainType()).toBe(dump.wallet.settings.chainType)
    expect(service.getLocale()).toBe(dump.wallet.settings.locale)
    service.setCurrency('EUR')
    await service.persist()

    const after = storage.values['preference'] as Record<string, unknown>
    expect(after.qbitSendPlanRemovals).toEqual(records)
    for (const [key, value] of Object.entries(saved)) {
      if (key !== 'currency' && key !== 'enableSignData') expect(after[key], key).toEqual(value)
    }
  })

  it('drops them with the wallets when the preferences are reset', async () => {
    const storage = new DumpStorage()
    const service = await load(storage)
    await service.addQbitSendPlanRemoval(WALLET, ACCOUNTS)

    await service.resetAllData({ keep: ['locale', 'themeMode'] })

    expect(service.getQbitSendPlanRemovals()).toEqual(NONE)
    expect(storage.values['preference']).not.toHaveProperty('qbitSendPlanRemovals')
  })
})
