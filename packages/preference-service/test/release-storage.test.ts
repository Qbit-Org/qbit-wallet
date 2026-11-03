import { describe, expect, it } from 'vitest'

import { BaseProxyStorageAdapter } from '@qbit/wallet-storage'
import { PreferenceService } from '../src/preference-service'
import {
  RELEASES,
  readReleaseStorage,
  type ReleaseStorage,
} from '../../../tests/fixtures/release-storage/release-storage'

// chrome.storage.local hands out copies, and keeps copies of what it is given.
class DumpStorage extends BaseProxyStorageAdapter {
  constructor(readonly values: Record<string, unknown>) {
    super()
  }

  async get(key: string): Promise<any> {
    return structuredClone(this.values[key])
  }

  async set(key: string, value: any): Promise<void> {
    this.values[key] = structuredClone(value)
  }
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function loadPreferences(dump: ReleaseStorage) {
  const storage = new DumpStorage(dump.storage)
  const service = new PreferenceService()
  await service.init({ storage, logger })
  return { service, storage }
}

describe.each(RELEASES)('preferences stored by %s', release => {
  it('load with the settings the release saved', async () => {
    const dump = readReleaseStorage(release)
    const { service } = await loadPreferences(dump)
    const { settings } = dump.wallet

    expect(service.getChainType()).toBe(settings.chainType)
    expect(service.getLocale()).toBe(settings.locale)
    expect(service.getThemeMode()).toBe(settings.themeMode)
    expect(service.getAutoLockTimeId()).toBe(settings.autoLockTimeId)
    expect(service.getDeveloperMode()).toBe(settings.developerMode)
  })

  it('load with the selected account and the names the release gave', async () => {
    const dump = readReleaseStorage(release)
    const { service } = await loadPreferences(dump)
    const [hdWallet, readonlyWallet] = dump.wallet.keyrings
    const savings = hdWallet!.accounts[1]!

    expect(service.getCurrentKeyringIndex()).toBe(0)
    expect(service.getCurrentAccount()).toMatchObject({
      type: hdWallet!.type,
      key: 'keyring_0#1',
      index: 1,
      pubkey: savings.pubkey,
      address: dump.wallet.currentAccount.address,
    })
    // The controller names keyring `n` and its account `i` by these keys.
    expect(service.getKeyringAlianName('keyring_0')).toBe(hdWallet!.alianName)
    expect(service.getKeyringAlianName('keyring_1')).toBe(readonlyWallet!.alianName)
    hdWallet!.accounts.forEach((account, index) => {
      expect(service.getAccountAlianName(`keyring_0#${index}`)).toBe(account.alianName)
    })
    expect(service.getAccountAlianName('keyring_1#0')).toBe(readonlyWallet!.accounts[0]!.alianName)
  })

  it('saves those settings back unchanged', async () => {
    const dump = readReleaseStorage(release)
    const before = structuredClone(dump.storage['preference']) as Record<string, unknown>
    const { service, storage } = await loadPreferences(dump)

    await service.persist()

    const saved = storage.values['preference'] as Record<string, unknown>
    for (const key of [
      'chainType',
      'locale',
      'themeMode',
      'autoLockTimeId',
      'developerMode',
      'currentKeyringIndex',
      'currentAccount',
      'keyringAlianNames',
      'accountAlianNames',
    ]) {
      expect(saved[key], key).toEqual(before[key])
    }
  })
})
