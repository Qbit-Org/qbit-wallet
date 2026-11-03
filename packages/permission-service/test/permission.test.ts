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

// Storage that writes the way the extension's does
// (apps/extension/src/background/utils/storage.ts): one write at a time in the
// order they were asked for, each value copied when it is asked for, and a
// later write kept even when an earlier one fails. Each write takes a moment.
const createQueuedStorage = () => {
  const store: Record<string, any> = {}
  const failures: Error[] = []
  let queue: Promise<void> = Promise.resolve()
  return {
    get: vi.fn(async (key: string) => {
      await queue
      return structuredClone(store[key])
    }),
    set: vi.fn((key: string, value: unknown): Promise<void> => {
      const snapshot = structuredClone(value)
      const failure = failures.shift()
      const write = queue.then(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (failure) throw failure
        store[key] = snapshot
      })
      queue = write.catch(() => undefined)
      return write
    }),
    // The next write asked for fails, as chrome.storage.local.set does once
    // the quota is used up.
    failNextWrite: () => failures.push(new Error('quota exceeded')),
    _store: store,
  }
}

// A service started the way the extension starts it, on queued storage that
// holds `sites`.
const startQueued = async (sites: ConnectedSite[]) => {
  const storage = createQueuedStorage()
  storage._store['permission'] = { version: 1, sites }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const service = new PermissionService()
  await service.init({ storage: storage as any, logger, autoSync: true })
  return { service, storage }
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

  describe('writes that overlap', () => {
    const a = site('https://a.example')
    const b = site('https://b.example')
    const c = site('https://c.example')

    // Every site, most recently used first: these tests keep them on mainnet.
    const everySite = (service: PermissionService) =>
      service.getSitesByDefaultChain(ChainType.QBIT_MAINNET)

    // Every site a restart would load from what is stored.
    const everySiteAfterRestart = async (storage: { _store: Record<string, any> }) =>
      everySite((await startWith(structuredClone(storage._store['permission']))).service)

    const connect = (service: PermissionService, { origin, name, icon, chain }: ConnectedSite) =>
      service.addConnectedSite(origin, name, icon, chain)

    it('does not undo a revocation made while a failed write was pending', async () => {
      const { service, storage } = await startQueued([a, b])
      storage.failNextWrite()

      const [touch, revoke] = await Promise.allSettled([
        service.touchConnectedSite(b.origin),
        service.removeConnectedSite(a.origin),
      ])

      expect(touch.status).toBe('rejected')
      expect(revoke.status).toBe('fulfilled')
      expect(service.hasPermission(a.origin)).toBe(false)
      expect(everySite(service)).toEqual([{ ...a, isConnected: false }, b])
      expect(await everySiteAfterRestart(storage)).toEqual(everySite(service))
    })

    it.each(['resetAllData', 'clearAllPermissions'] as const)(
      'does not bring back the sites %s removes when a write pending before it fails',
      async method => {
        const { service, storage } = await startQueued([a, b])
        storage.failNextWrite()

        const [touch, clear] = await Promise.allSettled([
          service.touchConnectedSite(b.origin),
          service[method](),
        ])

        expect(touch.status).toBe('rejected')
        expect(clear.status).toBe('fulfilled')
        expect(service.hasPermission(a.origin)).toBe(false)
        expect(service.hasPermission(b.origin)).toBe(false)
        expect(everySite(service)).toEqual([])
        expect(await everySiteAfterRestart(storage)).toEqual([])
      }
    )

    it.each(['resetAllData', 'clearAllPermissions'] as const)(
      'does not undo a change made while a failed %s was pending',
      async method => {
        const { service, storage } = await startQueued([a])
        storage.failNextWrite()

        const [clear, connectB] = await Promise.allSettled([service[method](), connect(service, b)])

        expect(clear.status).toBe('rejected')
        expect(connectB.status).toBe('fulfilled')
        expect(everySite(service)).toEqual([b, a])
        expect(await everySiteAfterRestart(storage)).toEqual([b, a])
      }
    )

    it('does not grant a connect reported as failed after a restart', async () => {
      const { service, storage } = await startQueued([])
      storage.failNextWrite()

      const [connectA, connectB] = await Promise.allSettled([
        connect(service, a),
        connect(service, b),
      ])

      expect(connectA.status).toBe('rejected')
      expect(connectB.status).toBe('fulfilled')
      expect(service.hasPermission(a.origin)).toBe(false)
      expect(service.hasPermission(b.origin)).toBe(true)
      expect(everySite(service)).toEqual([b])
      expect(await everySiteAfterRestart(storage)).toEqual([b])
    })

    it('does not apply a revocation reported as failed after a restart', async () => {
      const { service, storage } = await startQueued([a, b])
      storage.failNextWrite()

      const [revokeA, connectC] = await Promise.allSettled([
        service.removeConnectedSite(a.origin),
        connect(service, c),
      ])

      expect(revokeA.status).toBe('rejected')
      expect(connectC.status).toBe('fulfilled')
      expect(service.hasPermission(a.origin)).toBe(true)
      expect(service.hasPermission(c.origin)).toBe(true)
      expect(everySite(service)).toEqual([c, a, b])
      expect(await everySiteAfterRestart(storage)).toEqual([c, a, b])
    })

    it("does not reconnect a site revoked while another site's signing write failed", async () => {
      const { service, storage } = await startQueued([a, b])
      storage.failNextWrite()

      const [sign, revoke] = await Promise.allSettled([
        service.updateConnectSite(a.origin, { isSigned: true }, true),
        service.removeConnectedSite(b.origin),
      ])

      expect(sign.status).toBe('rejected')
      expect(revoke.status).toBe('fulfilled')
      expect(service.hasPermission(b.origin)).toBe(false)
      expect(service.getWithoutUpdate(a.origin)?.isSigned).toBe(false)
      expect(everySite(service)).toEqual([{ ...b, isConnected: false }, a])
      expect(await everySiteAfterRestart(storage)).toEqual(everySite(service))
    })

    it('starts a change asked for during a revocation from the revoked site', async () => {
      const { service, storage } = await startQueued([a, b])

      await Promise.all([
        service.removeConnectedSite(a.origin),
        service.topConnectedSite(a.origin),
        service.unpinConnectedSite(a.origin),
        service.setRecentConnectedSites([b]),
        service.updateConnectSite(b.origin, { isSigned: true }, true),
      ])

      expect(service.hasPermission(a.origin)).toBe(false)
      expect(everySite(service)).toEqual([
        { ...b, isSigned: true },
        { ...a, isConnected: false },
      ])
      expect(await everySiteAfterRestart(storage)).toEqual(everySite(service))
    })

    it('finds no site to change in a change asked for during a reset', async () => {
      const { service, storage } = await startQueued([a])

      await Promise.all([
        service.resetAllData(),
        service.updateConnectSite(a.origin, { isSigned: true }, true),
        service.touchConnectedSite(a.origin),
        service.topConnectedSite(a.origin),
        service.unpinConnectedSite(a.origin),
        service.removeConnectedSite(a.origin),
      ])

      expect(everySite(service)).toEqual([])
      expect(await everySiteAfterRestart(storage)).toEqual([])
      expect(storage.set).toHaveBeenCalledTimes(1)
    })

    it('stores the last change when the storage finishes an earlier write after a later one', async () => {
      // Storage that runs writes at once, the earlier ones taking longer.
      const storage = createMockStorage()
      let delay = 30
      storage.set.mockImplementation(async (key: string, value: unknown) => {
        const snapshot = structuredClone(value)
        await new Promise(resolve => setTimeout(resolve, (delay -= 10)))
        storage._store[key] = snapshot
      })
      const service = new PermissionService()
      await service.init({ storage: storage as any, logger: mockLogger, autoSync: true })

      await Promise.all([
        connect(service, a),
        connect(service, b),
        service.removeConnectedSite(a.origin),
      ])

      expect(service.hasPermission(a.origin)).toBe(false)
      expect(everySite(service)).toEqual([{ ...a, isConnected: false }, b])
      expect(await everySiteAfterRestart(storage)).toEqual(everySite(service))
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
    const bad = site('https://bad.example')
    const entry = (value: unknown, key = (value as ConnectedSite).origin) => ({
      k: key,
      v: value,
      e: 0,
    })

    it.each<[string, unknown]>([
      ['a string', 'not a record'],
      ['a list', [kept]],
      ['an object with neither a version nor a dump', { sites: [kept] }],
      ['an unknown version', { version: 2, sites: [kept] }],
      [
        'an unknown version that also carries a dump',
        { version: 2, sites: [kept], dumpCache: [entry(kept)] },
      ],
      ['a version given as a string', { version: '1', sites: [kept] }],
      ['version 1 without a site list', { version: 1 }],
      ['a dump that is not a list', { dumpCache: entry(kept) }],
    ])('rejects %s whole, without throwing, and starts with no grants', async (_shape, record) => {
      const { service, storage, logger } = await startWith(structuredClone(record))

      expect(service.getStats().total).toBe(0)
      expect(service.hasPermission(kept.origin)).toBe(false)
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

    it.each<[string, unknown]>([
      [
        'a site whose grant is not a boolean',
        { version: 1, sites: [kept, { ...bad, isConnected: 'true' }] },
      ],
      ['a site without an origin', { version: 1, sites: [kept, { ...bad, origin: '' }] }],
      ['a site without a chain', { version: 1, sites: [{ ...bad, chain: undefined }, kept] }],
      ['a site without a name', { version: 1, sites: [kept, { ...bad, name: undefined }] }],
      ['a site that is not an object', { version: 1, sites: [kept, null] }],
      ['a pin order that is not a number', { version: 1, sites: [kept, { ...bad, order: '1' }] }],
      ['a pin order of null', { dumpCache: [entry(kept), entry({ ...bad, order: null })] }],
      [
        'a quick multi-sign setting that is not a boolean',
        { version: 1, sites: [kept, { ...bad, allowQuickMultiSign: 'yes' }] },
      ],
      [
        'an expiry in the site that is not a number',
        { dumpCache: [entry(kept), entry({ ...bad, e: '0' })] },
      ],
      ['the same origin twice', { version: 1, sites: [bad, kept, { ...bad, isConnected: false }] }],
      ['a dump entry that is not an object', { dumpCache: [entry(kept), null] }],
      [
        'a dump entry in the shape later lru-cache versions write',
        { dumpCache: [entry(kept), [bad.origin, { value: bad }]] },
      ],
      [
        'a dump entry without a site',
        { dumpCache: [entry(kept), { k: bad.origin, v: 'bad', e: 0 }] },
      ],
      [
        'a dump entry that expires',
        { dumpCache: [entry(kept), { ...entry(bad), e: Date.now() + 60_000 }] },
      ],
      [
        'a dump entry kept under a key that is not an origin',
        { dumpCache: [entry(kept), entry(bad, 'bad')] },
      ],
      ['the same key twice in a dump', { dumpCache: [entry(bad), entry(kept), entry(bad)] }],
    ])('drops only %s, keeps the rest, and logs why', async (_shape, record) => {
      const { service, storage, logger } = await startWith(structuredClone(record))

      expect(service.getStats().total).toBe(1)
      expect(service.getWithoutUpdate(kept.origin)).toEqual(kept)
      expect(service.hasPermission(kept.origin, kept.chain)).toBe(true)
      expect(service.hasPermission(bad.origin)).toBe(false)
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('a stored site permission was not loaded'),
        expect.stringMatching(/^site \d+ /)
      )
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('stored site permissions were not loaded'),
        expect.anything()
      )
      expect(storage.set).not.toHaveBeenCalled()

      await service.touchConnectedSite(kept.origin)

      expect(storage._store['permission']).toEqual({ version: 1, sites: [kept] })
    })

    it('keeps a 1.0.6 grant under the key 1.0.6 checked it by, not the origin inside it', async () => {
      // 1.0.6's updateConnectSite(origin, value) kept `value` under `origin`
      // even when value.origin named another site, and checked the grant by
      // the key.
      const { service, logger } = await startWith({
        dumpCache: [entry(kept), entry(bad, 'https://key.example')],
      })

      expect(service.hasPermission('https://key.example', bad.chain)).toBe(true)
      expect(service.getWithoutUpdate('https://key.example')).toEqual({
        ...bad,
        origin: 'https://key.example',
      })
      expect(service.hasPermission(bad.origin)).toBe(false)
      expect(service.hasPermission(kept.origin)).toBe(true)
      expect(service.getStats().total).toBe(2)
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('drops a renamed 1.0.6 entry whose key another entry also holds', async () => {
      const { service } = await startWith({
        dumpCache: [entry(kept), entry(bad, kept.origin)],
      })

      expect(service.getStats().total).toBe(0)
      expect(service.hasPermission(kept.origin)).toBe(false)
      expect(service.hasPermission(bad.origin)).toBe(false)
    })

    it('rejects, and rolls back, a change that would store a site the next start would drop', async () => {
      const { service, storage } = await startWith({ version: 1, sites: [kept] })

      await expect(
        service.updateConnectSite(kept.origin, { order: 'first' } as any, true)
      ).rejects.toThrow('has an invalid order')
      await expect(service.setSite({ ...bad, isConnected: 'yes' } as any)).rejects.toThrow(
        'has no valid isConnected'
      )

      expect(storage.set).not.toHaveBeenCalled()
      expect(service.getWithoutUpdate(kept.origin)).toEqual(kept)
      expect(service.getWithoutUpdate(bad.origin)).toBeUndefined()
      expect(storage._store['permission']).toEqual({ version: 1, sites: [kept] })
    })

    describe.each(['resetAllData', 'clearAllPermissions'] as const)('%s', method => {
      // A service whose init could not read the stored record.
      const startUnread = async () => {
        const storage = createMockStorage()
        storage._store['permission'] = { version: 1, sites: [kept] }
        storage.get.mockRejectedValueOnce(new Error('read failed'))
        const service = new PermissionService()
        await expect(
          service.init({ storage: storage as any, logger: mockLogger, autoSync: true })
        ).rejects.toThrow('read failed')
        return { service, storage }
      }

      it('stores the empty record even when init could not read the stored one', async () => {
        const { service, storage } = await startUnread()

        await service[method]()

        expect(storage._store['permission']).toEqual({ version: 1, sites: [] })
        const { service: restarted } = await startWith(storage._store['permission'])
        expect(restarted.hasPermission(kept.origin)).toBe(false)
      })

      it('rejects when the empty record cannot be written', async () => {
        const { service, storage } = await startUnread()
        storage.set.mockRejectedValueOnce(new Error('storage unavailable'))

        await expect(service[method]()).rejects.toThrow('storage unavailable')

        expect(storage._store['permission']).toEqual({ version: 1, sites: [kept] })
        await expect(
          service.addConnectedSite(kept.origin, 'Kept', 'icon.png', ChainType.QBIT_MAINNET)
        ).rejects.toThrow('not initialized')
      })

      it('rejects, keeping every site, when the write fails after init', async () => {
        const { service, storage } = await startWith({ version: 1, sites: [kept] })
        storage.set.mockRejectedValueOnce(new Error('storage unavailable'))

        await expect(service[method]()).rejects.toThrow('storage unavailable')

        expect(service.hasPermission(kept.origin)).toBe(true)
      })

      it('rejects without storage', async () => {
        await expect(new PermissionService()[method]()).rejects.toThrow(
          'Storage adapter is required'
        )
      })
    })

    it.each<[string, (service: PermissionService) => Promise<void>]>([
      [
        'addConnectedSite',
        service =>
          service.addConnectedSite(kept.origin, 'Kept', 'icon.png', ChainType.QBIT_MAINNET),
      ],
      ['setSite', service => service.setSite(kept)],
      ['updateConnectSite', service => service.updateConnectSite(kept.origin, { name: 'K' }, true)],
      ['touchConnectedSite', service => service.touchConnectedSite(kept.origin)],
      ['removeConnectedSite', service => service.removeConnectedSite(kept.origin)],
      ['topConnectedSite', service => service.topConnectedSite(kept.origin)],
      ['unpinConnectedSite', service => service.unpinConnectedSite(kept.origin)],
      ['setRecentConnectedSites', service => service.setRecentConnectedSites([kept])],
    ])('%s rejects, storing nothing, before init has loaded the sites', async (_name, change) => {
      const storage = createMockStorage()
      storage._store['permission'] = { version: 1, sites: [kept] }
      storage.get.mockRejectedValueOnce(new Error('read failed'))
      const failed = new PermissionService()
      await failed.init({ storage: storage as any, logger: mockLogger }).catch(() => undefined)

      await expect(change(failed)).rejects.toThrow('not initialized')
      await expect(change(new PermissionService())).rejects.toThrow('not initialized')

      expect(storage.set).not.toHaveBeenCalled()
      expect(failed.hasPermission(kept.origin)).toBe(false)
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
