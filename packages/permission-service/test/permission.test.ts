import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { PermissionService } from '../src/permission-service'
import type { ConnectedSite } from '../src/types'
import { ChainType } from '@qbit/wallet-types'

const createMockStorage = () => {
  const store: Record<string, any> = {}
  return {
    get: vi.fn(async (key: string) => store[key]),
    set: vi.fn(async (key: string, value: any) => {
      store[key] = value
    }),
    _store: store,
  }
}

// The `permission` record 1.0.6 wrote: lru-cache 6's dump, most recently used
// first. Captured by running release/1.0.6's PermissionService with lru-cache
// 6.0.0, the copy it shipped with, on storage that keeps values as JSON the way
// chrome.storage.local does: four sites connected, one signed, one pinned with
// quick multi-sign, one moved to testnet4 and one disconnected, then a restart
// and a request from the local one.
const readRecord1_0_6 = () =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures/permission-1.0.6.json'), 'utf8'))

// The `permission` record after a downgrade: this release connected
// stale.example, then release/1.0.6's PermissionService (lru-cache 6.0.0)
// started on that record, read no grants, kept the keys it does not know, and
// connected after-downgrade.example into its dump.
const readRecordAfterDowngrade = () =>
  JSON.parse(
    readFileSync(join(__dirname, 'fixtures/permission-1.0.6-after-downgrade.json'), 'utf8')
  )

const site = (origin: string, value: Partial<ConnectedSite> = {}): ConnectedSite => ({
  origin,
  name: 'Site',
  icon: 'icon.png',
  chain: ChainType.QBIT_MAINNET,
  isSigned: false,
  isTop: false,
  isConnected: true,
  ...value,
})

// A service started the way the extension starts it, on `record`.
const startWith = async (record: unknown) => {
  const storage = createMockStorage()
  if (record !== undefined) storage._store['permission'] = record
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const service = new PermissionService()
  await service.init({ storage: storage as any, logger, autoSync: true })
  return { service, storage, logger }
}

const mockLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

describe('PermissionService', () => {
  let service: PermissionService
  let mockStorage: ReturnType<typeof createMockStorage>

  beforeEach(async () => {
    service = new PermissionService()
    mockStorage = createMockStorage()
    await service.init({
      storage: mockStorage as any,
      logger: mockLogger,
    })
  })

  describe('init', () => {
    it('should throw error if storage is not provided', async () => {
      const newService = new PermissionService()
      await expect(newService.init({} as any)).rejects.toThrow(
        'PermissionService: Storage adapter is required'
      )
    })

    it('should load existing cache from storage', async () => {
      const existingData = {
        dumpCache: [
          {
            k: 'https://example.com',
            v: {
              origin: 'https://example.com',
              name: 'Example',
              icon: 'icon.png',
              chain: ChainType.QBIT_MAINNET,
              isSigned: false,
              isTop: false,
              isConnected: true,
            },
            e: 0,
          },
        ],
      }
      const storage = createMockStorage()
      storage._store['permission'] = existingData

      const newService = new PermissionService()
      await newService.init({ storage: storage as any })

      const site = newService.getSite('https://example.com')
      expect(site).toBeDefined()
      expect(site?.name).toBe('Example')
    })

    it('should respect autoSync config', async () => {
      const storage = createMockStorage()
      const newService = new PermissionService()
      await newService.init({
        storage: storage as any,
        autoSync: true,
      })

      await newService.addConnectedSite(
        'https://autosync.com',
        'Auto Sync',
        'icon.png',
        ChainType.QBIT_MAINNET
      )

      expect(storage.set).toHaveBeenCalledWith('permission', {
        version: 1,
        sites: [expect.objectContaining({ origin: 'https://autosync.com' })],
      })
    })

    it('should respect internalRequestOrigin config', async () => {
      const newService = new PermissionService()
      await newService.init({
        storage: createMockStorage() as any,
        internalRequestOrigin: 'app://internal',
      })

      expect(newService.isInternalOrigin('app://internal')).toBe(true)
      expect(newService.hasPermission('app://internal')).toBe(false)
      expect(newService.isInternalOrigin('https://qbit.org')).toBe(false)
    })
  })

  describe('addConnectedSite', () => {
    it('should add a new connected site', async () => {
      await service.addConnectedSite(
        'https://test.com',
        'Test Site',
        'test-icon.png',
        ChainType.QBIT_MAINNET
      )

      const site = service.getSite('https://test.com')
      expect(site).toBeDefined()
      expect(site?.origin).toBe('https://test.com')
      expect(site?.name).toBe('Test Site')
      expect(site?.isConnected).toBe(true)
      expect(site?.isTop).toBe(false)
    })

    it('should set isSigned when provided', async () => {
      await service.addConnectedSite(
        'https://signed.com',
        'Signed Site',
        'icon.png',
        ChainType.QBIT_MAINNET,
        true
      )

      const site = service.getSite('https://signed.com')
      expect(site?.isSigned).toBe(true)
    })
  })

  describe('getSite / getConnectedSite', () => {
    beforeEach(async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)
    })

    it('should return site by origin', () => {
      const site = service.getSite('https://test.com')
      expect(site).toBeDefined()
    })

    it('should return undefined for non-existent site', () => {
      const site = service.getSite('https://nonexistent.com')
      expect(site).toBeUndefined()
    })

    it('getConnectedSite should return undefined for disconnected site', async () => {
      await service.removeConnectedSite('https://test.com')
      const site = service.getConnectedSite('https://test.com')
      expect(site).toBeUndefined()
    })
  })

  describe('getWithoutUpdate', () => {
    it('should return site without updating LRU order', async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)

      const site = service.getWithoutUpdate('https://test.com')
      expect(site).toBeDefined()
      expect(site?.origin).toBe('https://test.com')
    })
  })

  describe('hasPermission', () => {
    it('should return true for connected site', async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)

      expect(service.hasPermission('https://test.com')).toBe(true)
      expect(service.hasPermission('https://test.com', ChainType.QBIT_MAINNET)).toBe(true)
      expect(service.hasPermission('https://test.com', ChainType.QBIT_TESTNET4)).toBe(false)
    })

    it('should return false for non-existent site', () => {
      expect(service.hasPermission('https://unknown.com')).toBe(false)
    })

    it('should not implicitly authorize a configured internal origin', () => {
      expect(service.hasPermission('https://qbit.org')).toBe(false)
    })

    it('should return false for disconnected site', async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)
      await service.removeConnectedSite('https://test.com')

      expect(service.hasPermission('https://test.com')).toBe(false)
    })
  })

  describe('updateConnectSite', () => {
    beforeEach(async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)
    })

    it('should update site with partial update', async () => {
      await service.updateConnectSite('https://test.com', { name: 'Updated Name' }, true)

      const site = service.getSite('https://test.com')
      expect(site?.name).toBe('Updated Name')
      expect(site?.origin).toBe('https://test.com')
    })

    it('should replace site without partial update', async () => {
      await service.updateConnectSite('https://test.com', {
        origin: 'https://test.com',
        name: 'Replaced',
        icon: 'new-icon.png',
        chain: ChainType.QBIT_TESTNET4,
        isSigned: true,
        isTop: true,
        isConnected: true,
      })

      const site = service.getSite('https://test.com')
      expect(site?.name).toBe('Replaced')
      expect(site?.chain).toBe(ChainType.QBIT_TESTNET4)
    })

    it('should treat configured internal origins like explicit grants', async () => {
      await service.addConnectedSite('https://qbit.org', 'Qbit', 'icon.png', ChainType.QBIT_MAINNET)
      await service.updateConnectSite('https://qbit.org', { name: 'Changed' }, true)

      const site = service.getSite('https://qbit.org')
      expect(site?.name).toBe('Changed')
    })
  })

  describe('topConnectedSite / unpinConnectedSite', () => {
    beforeEach(async () => {
      await service.addConnectedSite(
        'https://site1.com',
        'Site 1',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.addConnectedSite(
        'https://site2.com',
        'Site 2',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
    })

    it('should pin site to top', async () => {
      await service.topConnectedSite('https://site1.com')

      const site = service.getSite('https://site1.com')
      expect(site?.isTop).toBe(true)
      expect(site?.order).toBe(1)
    })

    it('should pin with custom order', async () => {
      await service.topConnectedSite('https://site1.com', 5)

      const site = service.getSite('https://site1.com')
      expect(site?.order).toBe(5)
    })

    it('should unpin site', async () => {
      await service.topConnectedSite('https://site1.com')
      await service.unpinConnectedSite('https://site1.com')

      const site = service.getSite('https://site1.com')
      expect(site?.isTop).toBe(false)
    })
  })

  describe('getRecentConnectedSites', () => {
    beforeEach(async () => {
      await service.addConnectedSite(
        'https://site1.com',
        'Site 1',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.addConnectedSite(
        'https://site2.com',
        'Site 2',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.addConnectedSite(
        'https://site3.com',
        'Site 3',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
    })

    it('should return connected sites with pinned first', async () => {
      await service.topConnectedSite('https://site2.com', 1)

      const sites = service.getRecentConnectedSites()
      expect(sites[0].origin).toBe('https://site2.com')
    })

    it('should sort pinned sites by order', async () => {
      await service.topConnectedSite('https://site1.com', 2)
      await service.topConnectedSite('https://site3.com', 1)

      const sites = service.getRecentConnectedSites()
      expect(sites[0].origin).toBe('https://site3.com')
      expect(sites[1].origin).toBe('https://site1.com')
    })
  })

  describe('getConnectedSites', () => {
    it('should return only connected sites', async () => {
      await service.addConnectedSite(
        'https://connected.com',
        'Connected',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.addConnectedSite(
        'https://disconnected.com',
        'Disconnected',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.removeConnectedSite('https://disconnected.com')

      const sites = service.getConnectedSites()
      expect(sites.length).toBe(1)
      expect(sites[0].origin).toBe('https://connected.com')
    })
  })

  describe('getSitesByDefaultChain', () => {
    it('should filter sites by chain', async () => {
      await service.addConnectedSite(
        'https://mainnet.com',
        'Mainnet',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.addConnectedSite(
        'https://testnet.com',
        'Testnet',
        'icon.png',
        ChainType.QBIT_TESTNET4
      )

      const mainnetSites = service.getSitesByDefaultChain(ChainType.QBIT_MAINNET)
      expect(mainnetSites.length).toBe(1)
      expect(mainnetSites[0].origin).toBe('https://mainnet.com')
    })
  })

  describe('removeConnectedSite', () => {
    it('should mark site as disconnected', async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)
      await service.removeConnectedSite('https://test.com')

      const site = service.getSite('https://test.com')
      expect(site?.isConnected).toBe(false)
    })

    it('should do nothing for non-existent site', async () => {
      await service.removeConnectedSite('https://nonexistent.com')
      expect(service.getSite('https://nonexistent.com')).toBeUndefined()
    })
  })

  describe('durable permissions', () => {
    it('restores a chain-scoped grant and its revocation across service instances', async () => {
      const storage = createMockStorage()
      const first = new PermissionService()
      await first.init({ storage: storage as any, autoSync: true })

      await first.addConnectedSite(
        'https://persistent.example',
        'Persistent',
        'icon.png',
        ChainType.QBIT_REGTEST
      )

      const restored = new PermissionService()
      await restored.init({ storage: storage as any, autoSync: true })
      expect(restored.hasPermission('https://persistent.example', ChainType.QBIT_REGTEST)).toBe(
        true
      )
      expect(restored.hasPermission('https://persistent.example', ChainType.QBIT_TESTNET4)).toBe(
        false
      )

      await restored.removeConnectedSite('https://persistent.example')

      const afterRevoke = new PermissionService()
      await afterRevoke.init({ storage: storage as any, autoSync: true })
      expect(afterRevoke.hasPermission('https://persistent.example')).toBe(false)
      expect(afterRevoke.getSite('https://persistent.example')?.isConnected).toBe(false)
    })

    it('rolls back an in-memory grant when persistence fails', async () => {
      const storage = createMockStorage()
      const persistent = new PermissionService()
      await persistent.init({ storage: storage as any, autoSync: true })
      storage.set.mockRejectedValueOnce(new Error('storage unavailable'))

      await expect(
        persistent.addConnectedSite(
          'https://failed.example',
          'Failed',
          'icon.png',
          ChainType.QBIT_TESTNET4
        )
      ).rejects.toThrow('storage unavailable')

      expect(persistent.hasPermission('https://failed.example')).toBe(false)
      expect(persistent.getSite('https://failed.example')).toBeUndefined()
    })

    it('rolls back an in-memory revocation when persistence fails', async () => {
      const storage = createMockStorage()
      const persistent = new PermissionService()
      await persistent.init({ storage: storage as any, autoSync: true })
      await persistent.addConnectedSite(
        'https://failed-revoke.example',
        'Failed revoke',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      storage.set.mockRejectedValueOnce(new Error('storage unavailable'))

      await expect(persistent.removeConnectedSite('https://failed-revoke.example')).rejects.toThrow(
        'storage unavailable'
      )

      expect(
        persistent.hasPermission('https://failed-revoke.example', ChainType.QBIT_MAINNET)
      ).toBe(true)
    })
  })

  describe('stored record', () => {
    it('loads a version 1 record, most recently used first', async () => {
      const { service, storage, logger } = await startWith({
        version: 1,
        sites: [
          site('https://recent.example', { chain: ChainType.QBIT_TESTNET4, isSigned: true }),
          site('https://pinned.example', { isTop: true, order: 1, allowQuickMultiSign: true }),
          site('https://revoked.example', { isConnected: false }),
        ],
      })

      expect(service.hasPermission('https://recent.example', ChainType.QBIT_TESTNET4)).toBe(true)
      expect(service.hasPermission('https://recent.example', ChainType.QBIT_MAINNET)).toBe(false)
      expect(service.getWithoutUpdate('https://recent.example')?.isSigned).toBe(true)
      expect(service.getWithoutUpdate('https://pinned.example')).toMatchObject({
        isTop: true,
        order: 1,
        allowQuickMultiSign: true,
      })
      expect(service.hasPermission('https://revoked.example')).toBe(false)
      expect(service.getWithoutUpdate('https://revoked.example')?.isConnected).toBe(false)
      expect(service.getConnectedSites().map(item => item.origin)).toEqual([
        'https://recent.example',
        'https://pinned.example',
      ])
      expect(logger.error).not.toHaveBeenCalled()
      expect(storage.set).not.toHaveBeenCalled()
    })

    it('converts the record 1.0.6 wrote with every grant, and versions it on the next write', async () => {
      const record = readRecord1_0_6()
      const { service, storage, logger } = await startWith(record)

      // Every grant and revocation, on the chain it was given for.
      expect(service.getStats()).toEqual({ total: 4, connected: 3, pinned: 1 })
      for (const { k, v } of record.dumpCache) {
        expect(service.getWithoutUpdate(k)).toEqual(v)
        expect(service.hasPermission(k, v.chain)).toBe(v.isConnected)
      }
      expect(service.hasPermission('https://swap.example', ChainType.QBIT_MAINNET)).toBe(false)
      expect(service.hasPermission('https://old.example')).toBe(false)
      // In the order 1.0.6 kept them: pinned first, then most recently used.
      expect(service.getRecentConnectedSites().map(item => item.origin)).toEqual([
        'https://nft.example',
        'http://127.0.0.1:3000',
        'https://swap.example',
      ])
      expect(logger.error).not.toHaveBeenCalled()
      // The record stays as 1.0.6 wrote it until the next write.
      expect(storage.set).not.toHaveBeenCalled()
      expect(storage._store['permission']).toEqual(readRecord1_0_6())

      await service.updateConnectSite('https://swap.example', { name: 'Swap 2' }, true)

      expect(storage.set).toHaveBeenCalledTimes(1)
      const [swap, local, old, nft] = [2, 0, 1, 3].map(index => record.dumpCache[index].v)
      expect(storage._store['permission']).toEqual({
        version: 1,
        sites: [{ ...swap, name: 'Swap 2' }, local, old, nft],
      })

      const { service: restarted } = await startWith(storage._store['permission'])
      expect(restarted.getStats()).toEqual(service.getStats())
      expect(restarted.getConnectedSites()).toEqual(service.getConnectedSites())
    })

    it('reads what 1.0.6 did after a downgrade, not the grants it never showed', async () => {
      const { service, storage, logger } = await startWith(readRecordAfterDowngrade())

      expect(
        service.hasPermission('https://after-downgrade.example', ChainType.QBIT_TESTNET4)
      ).toBe(true)
      expect(service.hasPermission('https://stale.example')).toBe(false)
      expect(service.getStats().total).toBe(1)
      expect(logger.error).not.toHaveBeenCalled()
      expect(storage.set).not.toHaveBeenCalled()

      await service.touchConnectedSite('https://after-downgrade.example')

      expect(storage._store['permission']).toEqual({
        version: 1,
        sites: [readRecordAfterDowngrade().dumpCache[0].v],
      })

      // 1.0.6 started but connected nothing: nothing comes back.
      const { service: untouched } = await startWith({
        ...readRecordAfterDowngrade(),
        dumpCache: [],
      })
      expect(untouched.getStats().total).toBe(0)
    })

    it('starts empty, and writes nothing, when nothing is stored', async () => {
      for (const record of [undefined, null, { dumpCache: [] }, { version: 1, sites: [] }]) {
        const { service, storage, logger } = await startWith(record)

        expect(service.getStats().total).toBe(0)
        expect(logger.error).not.toHaveBeenCalled()
        expect(storage.set).not.toHaveBeenCalled()
      }
    })

    const kept = site('https://kept.example')
    it.each<[string, unknown]>([
      ['a string', 'not a record'],
      ['a list', [kept]],
      ['an object with neither a version nor a dump', { sites: [kept] }],
      [
        'an unknown version that also carries a dump',
        { version: 2, sites: [kept], dumpCache: [{ k: kept.origin, v: kept, e: 0 }] },
      ],
      ['a version given as a string', { version: '1', sites: [kept] }],
      ['version 1 without a site list', { version: 1 }],
      [
        'a site whose grant is not a boolean',
        { version: 1, sites: [{ ...kept, isConnected: 'true' }] },
      ],
      ['a site without an origin', { version: 1, sites: [kept, { ...kept, origin: '' }] }],
      ['a site without a chain', { version: 1, sites: [{ ...kept, chain: undefined }] }],
      ['the same origin twice', { version: 1, sites: [kept, { ...kept, isConnected: false }] }],
      ['a site that is not an object', { version: 1, sites: [kept, null] }],
      ['a pin order that is not a number', { version: 1, sites: [{ ...kept, order: '1' }] }],
      ['a dump that is not a list', { dumpCache: { k: kept.origin, v: kept, e: 0 } }],
      [
        'a dump entry that is not an object',
        { dumpCache: [{ k: kept.origin, v: kept, e: 0 }, null] },
      ],
      [
        'a dump in the shape later lru-cache versions write',
        { dumpCache: [[kept.origin, { value: kept }]] },
      ],
      [
        'a dump entry under another origin',
        { dumpCache: [{ k: 'https://other.example', v: kept, e: 0 }] },
      ],
      [
        'a dump entry that expires',
        { dumpCache: [{ k: kept.origin, v: kept, e: Date.now() + 60_000 }] },
      ],
    ])('rejects %s without throwing and starts with no grants', async (_shape, record) => {
      const { service, storage, logger } = await startWith(structuredClone(record))

      expect(service.getStats().total).toBe(0)
      expect(service.hasPermission(kept.origin)).toBe(false)
      expect(service.hasPermission('https://other.example')).toBe(false)
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('stored site permissions were not loaded'),
        expect.any(String)
      )
      // Left on disk as it was until the next write, which is versioned.
      expect(storage.set).not.toHaveBeenCalled()
      expect(storage._store['permission']).toEqual(record)

      await service.addConnectedSite(
        'https://new.example',
        'New',
        'icon.png',
        ChainType.QBIT_MAINNET
      )

      expect(storage._store['permission']).toEqual({
        version: 1,
        sites: [site('https://new.example', { name: 'New' })],
      })
    })

    it('keeps a site under the origin it was granted to', async () => {
      const { service, storage } = await startWith(undefined)
      await service.addConnectedSite('https://a.example', 'A', 'icon.png', ChainType.QBIT_MAINNET)

      await service.updateConnectSite('https://a.example', site('https://b.example'))

      expect(service.getWithoutUpdate('https://a.example')?.origin).toBe('https://a.example')
      expect(service.hasPermission('https://b.example')).toBe(false)
      const { service: restarted } = await startWith(storage._store['permission'])
      expect(restarted.hasPermission('https://a.example')).toBe(true)
      expect(restarted.hasPermission('https://b.example')).toBe(false)
    })

    it('keeps the 1000 most recently used sites', async () => {
      const { service, storage } = await startWith(undefined)
      for (let index = 0; index <= 1000; index++) {
        await service.addConnectedSite(
          `https://site${index}.example`,
          `Site ${index}`,
          'icon.png',
          ChainType.QBIT_MAINNET
        )
      }

      expect(service.getStats().total).toBe(1000)
      expect(service.hasPermission('https://site0.example')).toBe(false)
      expect(service.hasPermission('https://site1.example')).toBe(true)
      expect(storage._store['permission'].sites[0].origin).toBe('https://site1000.example')
      expect(storage._store['permission'].sites).toHaveLength(1000)
    })
  })

  describe('clearAllPermissions', () => {
    it('should clear all sites', async () => {
      await service.addConnectedSite(
        'https://site1.com',
        'Site 1',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.addConnectedSite(
        'https://site2.com',
        'Site 2',
        'icon.png',
        ChainType.QBIT_MAINNET
      )

      await service.clearAllPermissions()

      expect(service.getConnectedSites().length).toBe(0)
      expect(mockStorage.set).toHaveBeenCalledWith('permission', { version: 1, sites: [] })
    })
  })

  describe('resetAllData', () => {
    it('should reset all data', async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)

      await service.resetAllData()

      expect(service.getConnectedSites().length).toBe(0)
    })
  })

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      await service.addConnectedSite(
        'https://site1.com',
        'Site 1',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.addConnectedSite(
        'https://site2.com',
        'Site 2',
        'icon.png',
        ChainType.QBIT_MAINNET
      )
      await service.topConnectedSite('https://site1.com')

      const stats = service.getStats()
      expect(stats.total).toBe(2)
      expect(stats.connected).toBe(2)
      expect(stats.pinned).toBe(1)
    })

    it('should return zeros when no sites', () => {
      const stats = service.getStats()
      expect(stats.total).toBe(0)
      expect(stats.connected).toBe(0)
      expect(stats.pinned).toBe(0)
    })
  })

  describe('isInternalOrigin', () => {
    it('should return true for internal origin', () => {
      expect(service.isInternalOrigin('https://qbit.org')).toBe(true)
    })

    it('should return false for external origin', () => {
      expect(service.isInternalOrigin('https://example.com')).toBe(false)
    })
  })

  describe('setRecentConnectedSites', () => {
    it('should set sites order', async () => {
      await service.addConnectedSite(
        'https://site1.com',
        'Site 1',
        'icon.png',
        ChainType.QBIT_MAINNET
      )

      const newSites = [
        {
          origin: 'https://new-site.com',
          name: 'New Site',
          icon: 'icon.png',
          chain: ChainType.QBIT_MAINNET,
          isSigned: false,
          isTop: false,
          isConnected: true,
        },
      ]

      await service.setRecentConnectedSites(newSites)

      const site = service.getSite('https://new-site.com')
      expect(site).toBeDefined()
      expect(site?.name).toBe('New Site')
    })
  })

  describe('touchConnectedSite', () => {
    it('should not throw for existing site', async () => {
      await service.addConnectedSite('https://test.com', 'Test', 'icon.png', ChainType.QBIT_MAINNET)

      await expect(service.touchConnectedSite('https://test.com')).resolves.not.toThrow()
    })

    it('should skip internal origin', async () => {
      await expect(service.touchConnectedSite('https://qbit.org')).resolves.not.toThrow()
    })
  })
})
