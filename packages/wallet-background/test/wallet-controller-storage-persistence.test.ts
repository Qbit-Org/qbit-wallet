import { PreferenceService } from '@qbit/preference-service'
import { ChainType } from '@qbit/wallet-types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import walletController from '../src/controllers/wallet'
import { contactBookService, preferenceService } from '../src/services'

// Keeps what was written as JSON, like chrome.storage.local, so a service
// started on it again sees only what reached disk. Its persistent proxies never
// save by themselves: a value is on disk only after an explicit write.
class DiskAdapter {
  disk = new Map<string, string>()
  writeErrors: Error[] = []

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    return { ...template, ...(await this.get(name)) }
  }

  async get(key: string): Promise<any> {
    const raw = this.disk.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: any): Promise<void> {
    const writeError = this.writeErrors.shift()
    if (writeError) throw writeError
    this.disk.set(key, JSON.stringify(value))
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const adapter = new DiskAdapter()

const reloadPreferences = async () => {
  const service = new PreferenceService()
  await service.init({ storage: adapter as any, logger })
  return service
}

describe('WalletController storage persistence', () => {
  beforeAll(async () => {
    await preferenceService.init({ storage: adapter as any, logger })
    await contactBookService.init({ storage: adapter as any, logger })
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('has security settings on disk when the setter resolves, before the debounced save', async () => {
    await walletController.setEnableSignData(true)
    await walletController.setAutoLockTimeId(1)
    await walletController.setEnableRBF(false)

    const reloaded = await reloadPreferences()
    expect(reloaded.getEnableSignData()).toBe(true)
    expect(reloaded.getAutoLockTimeId()).toBe(1)
    expect(reloaded.getEnableRBF()).toBe(false)

    await walletController.setEnableSignData(false)
    expect((await reloadPreferences()).getEnableSignData()).toBe(false)
  })

  it('rejects a security setting whose write fails and keeps the previous value', async () => {
    await walletController.setEnableRBF(true)
    const writeError = new Error('QUOTA_BYTES quota exceeded')
    adapter.writeErrors.push(writeError)

    await expect(walletController.setEnableRBF(false)).rejects.toBe(writeError)
    expect(await walletController.getEnableRBF()).toBe(true)
    expect((await reloadPreferences()).getEnableRBF()).toBe(true)
  })

  it('resolves a contact write only once it is on disk and rejects a failed one', async () => {
    const contact = {
      name: 'Alice',
      address: 'qb1zalice',
      chain: ChainType.QBIT_MAINNET,
      isAlias: false,
      isContact: true,
    }

    await walletController.addContact(contact)
    expect(JSON.parse(adapter.disk.get('contactBook')!)).toHaveProperty(
      'qb1zalice_QBIT_MAINNET.name',
      'Alice'
    )

    const writeError = new Error('QUOTA_BYTES quota exceeded')
    adapter.writeErrors.push(writeError)
    await expect(walletController.updateContact({ ...contact, name: 'Mallory' })).rejects.toBe(
      writeError
    )
    expect(walletController.getContactByAddress('qb1zalice')?.name).toBe('Alice')

    adapter.writeErrors.push(writeError)
    await expect(walletController.removeContact('qb1zalice', ChainType.QBIT_MAINNET)).rejects.toBe(
      writeError
    )
    expect(walletController.listContacts()).toHaveLength(1)

    await walletController.removeContact('qb1zalice', ChainType.QBIT_MAINNET)
    expect(walletController.listContacts()).toEqual([])
    expect(JSON.parse(adapter.disk.get('contactBook')!)).toEqual({})
  })
})
