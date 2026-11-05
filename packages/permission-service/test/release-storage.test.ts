import { describe, expect, it } from 'vitest'

import { ChainType } from '@qbit/wallet-types'
import { PermissionService } from '../src/permission-service'
import {
  RELEASES,
  readReleaseStorage,
} from '../../../tests/fixtures/release-storage/release-storage'

// chrome.storage.local hands out copies, and keeps copies of what it is given.
class DumpStorage {
  constructor(readonly values: Record<string, unknown>) {}

  async get(key: string): Promise<any> {
    return structuredClone(this.values[key])
  }

  async set(key: string, value: any): Promise<void> {
    this.values[key] = structuredClone(value)
  }
}

const quietLogger = () => {
  const errors: unknown[][] = []
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error: (...args: unknown[]) => {
      errors.push(args)
    },
  }
  return { logger, errors }
}

async function loadPermissions(values: Record<string, unknown>) {
  const { logger, errors } = quietLogger()
  const service = new PermissionService()
  // As the extension starts it: every change is saved at once.
  await service.init({ storage: new DumpStorage(values) as any, logger, autoSync: true })
  return { service, errors }
}

describe.each(RELEASES)('site permissions stored by %s', release => {
  it('load with the site the release connected', async () => {
    const dump = readReleaseStorage(release)
    const { service, errors } = await loadPermissions(dump.storage)

    expect(errors).toEqual([])
    expect(dump.wallet.connectedSites).toHaveLength(1)
    const [site] = dump.wallet.connectedSites
    expect(service.getConnectedSites()).toEqual([
      expect.objectContaining({ origin: site!.origin, chain: site!.chain, isConnected: true }),
    ])
    expect(service.hasPermission(site!.origin, site!.chain as ChainType)).toBe(true)
    expect(service.hasPermission(site!.origin, ChainType.QBIT_MAINNET)).toBe(false)
  })

  it('keep that site when the next change is saved', async () => {
    const dump = readReleaseStorage(release)
    const [site] = dump.wallet.connectedSites
    const { service } = await loadPermissions(dump.storage)

    await service.touchConnectedSite(site!.origin)
    // Saved in the record this release writes, whatever the release before wrote.
    expect(dump.storage['permission']).toMatchObject({ version: 1 })

    const { service: reloaded, errors } = await loadPermissions(dump.storage)
    expect(errors).toEqual([])
    expect(reloaded.hasPermission(site!.origin, site!.chain as ChainType)).toBe(true)
  })
})
