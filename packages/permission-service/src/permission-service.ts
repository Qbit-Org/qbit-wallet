import LRUCacheModule from 'lru-cache'
// Handle both ESM default export and CommonJS named export
const LRUCache = (LRUCacheModule as any).LRUCache || LRUCacheModule

import type { ConnectedSite, PermissionStore, PermissionServiceConfig, Logger } from './types'
import { defaultLogger } from './types'
import { ChainType } from '@qbit/wallet-types'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'

/**
 * Cross-platform permission service for managing dApp connections
 */
export class PermissionService {
  private store: PermissionStore = {
    dumpCache: [],
  }
  // @ts-ignore
  private lruCache: LRUCache<string, ConnectedSite> | undefined
  protected storage: ProxyStorageAdapter = undefined as any
  private storageKey: string = 'permission'
  private logger: Logger = defaultLogger
  private autoSync: boolean = false
  private internalRequestOrigin: string = 'https://qbit.org'

  constructor() {}

  /**
   * Initialize the permission service
   */
  async init(config: PermissionServiceConfig): Promise<void> {
    try {
      if (config.storage) {
        this.storage = config.storage
      }

      if (config.logger) {
        this.logger = config.logger
      }

      if (config.storageKey) {
        this.storageKey = config.storageKey
      }

      if (config.autoSync !== undefined) {
        this.autoSync = config.autoSync
      }

      if (config.internalRequestOrigin) {
        this.internalRequestOrigin = config.internalRequestOrigin
      }

      if (!this.storage) {
        throw new Error('PermissionService: Storage adapter is required')
      }

      const storedData = await this.storage.get(this.storageKey)
      this.store = storedData || { dumpCache: [] }

      this.lruCache = new LRUCache({ max: 1000 })
      const cache = this.store.dumpCache || []
      this.lruCache.load(cache)

      await this.sync()

      this.logger.debug?.('PermissionService initialized with', cache.length, 'cached sites')
    } catch (error) {
      this.logger.error('Failed to initialize PermissionService:', error)
      throw error
    }
  }

  resetAllData = async (): Promise<void> => {
    await this.mutateAndSync(() => this.lruCache?.reset(), true)
  }

  /**
   * Sync cache to storage
   */
  private async sync(): Promise<void> {
    if (!this.autoSync || !this.lruCache) return

    try {
      this.store.dumpCache = this.lruCache.dump()
      await this.storage.set(this.storageKey, this.store)
    } catch (error) {
      this.logger.error('Failed to sync permission data:', error)
      throw error
    }
  }

  /**
   * Apply a permission mutation atomically with its persisted representation.
   * A failed write must not leave an in-memory grant or revocation that differs
   * from what will be restored after a service-worker restart.
   */
  private async mutateAndSync(mutate: () => void, forceSync = false): Promise<void> {
    if (!this.lruCache) return

    const previousDump = this.lruCache.dump()
    mutate()
    try {
      if (forceSync) {
        this.store = { dumpCache: this.lruCache.dump() }
        await this.storage.set(this.storageKey, this.store)
      } else {
        await this.sync()
      }
    } catch (error) {
      this.lruCache.reset()
      this.lruCache.load(previousDump)
      this.store = { dumpCache: previousDump }
      throw error
    }
  }

  /**
   * Get site without updating LRU order
   */
  getWithoutUpdate(key: string): ConnectedSite | undefined {
    if (!this.lruCache) return
    return this.lruCache.peek(key)
  }

  /**
   * Get site information
   */
  getSite(origin: string): ConnectedSite | undefined {
    return this.lruCache?.get(origin)
  }

  /**
   * Set site information
   */
  async setSite(site: ConnectedSite): Promise<void> {
    await this.mutateAndSync(() => this.lruCache!.set(site.origin, site))
  }

  /**
   * Add a new connected site
   */
  async addConnectedSite(
    origin: string,
    name: string,
    icon: string,
    defaultChain: ChainType,
    isSigned = false
  ): Promise<void> {
    await this.mutateAndSync(() =>
      this.lruCache!.set(origin, {
        origin,
        name,
        icon,
        chain: defaultChain,
        isSigned,
        isTop: false,
        isConnected: true,
      })
    )
  }

  /**
   * Touch connected site (update LRU order)
   */
  async touchConnectedSite(origin: string): Promise<void> {
    if (!this.lruCache?.has(origin)) return
    await this.mutateAndSync(() => this.lruCache!.get(origin))
  }

  /**
   * Update connected site
   */
  async updateConnectSite(
    origin: string,
    value: Partial<ConnectedSite>,
    partialUpdate?: boolean
  ): Promise<void> {
    if (!this.lruCache?.has(origin)) return

    await this.mutateAndSync(() => {
      if (partialUpdate) {
        const existingValue = this.lruCache!.peek(origin)
        this.lruCache!.set(origin, { ...existingValue, ...value } as ConnectedSite)
      } else {
        this.lruCache!.set(origin, value as ConnectedSite)
      }
    })
  }

  /**
   * Check if origin has permission
   */
  hasPermission(origin: string, chain?: ChainType): boolean {
    if (!this.lruCache) return false
    const site = this.lruCache.peek(origin)
    return Boolean(site?.isConnected && (chain === undefined || site.chain === chain))
  }

  /**
   * Set recent connected sites order
   */
  async setRecentConnectedSites(sites: ConnectedSite[]): Promise<void> {
    if (!this.lruCache) return

    const disconnectedSites = [...this.lruCache.values()]
      .filter((item: ConnectedSite) => !item.isConnected)
      .map((item: ConnectedSite) => ({
        k: item.origin,
        v: item,
        e: 0,
      }))
    await this.mutateAndSync(() => {
      this.lruCache!.reset()
      this.lruCache!.load(
        sites
          .map((item: ConnectedSite) => ({
            k: item.origin,
            v: item,
            e: 0,
          }))
          .concat(disconnectedSites)
      )
    })
  }

  /**
   * Get recent connected sites (ordered with pinned sites first)
   */
  getRecentConnectedSites(): ConnectedSite[] {
    const sites = [...(this.lruCache?.values() || [])].filter(
      (item: ConnectedSite) => item.isConnected
    )
    const pinnedSites = sites
      .filter((item: ConnectedSite) => item?.isTop)
      .sort((a: ConnectedSite, b: ConnectedSite) => (a.order || 0) - (b.order || 0))
    const recentSites = sites.filter((item: ConnectedSite) => !item.isTop)
    return [...pinnedSites, ...recentSites]
  }

  /**
   * Get all connected sites
   */
  getConnectedSites(): ConnectedSite[] {
    return [...(this.lruCache?.values() || [])].filter((item: ConnectedSite) => item.isConnected)
  }

  /**
   * Get connected site by key
   */
  getConnectedSite(key: string): ConnectedSite | undefined {
    const site = this.lruCache?.get(key)
    if (site && site.isConnected) {
      return site
    }
    return undefined
  }

  /**
   * Pin a connected site to top
   */
  async topConnectedSite(origin: string, order?: number): Promise<void> {
    const site = this.getConnectedSite(origin)
    if (!site || !this.lruCache) return

    const maxOrder = Math.max(...this.getRecentConnectedSites().map(item => item.order || 0), 0)
    const finalOrder = order ?? maxOrder + 1

    await this.updateConnectSite(origin, {
      ...site,
      order: finalOrder,
      isTop: true,
    })
  }

  /**
   * Unpin a connected site
   */
  async unpinConnectedSite(origin: string): Promise<void> {
    const site = this.getConnectedSite(origin)
    if (!site || !this.lruCache) return

    await this.updateConnectSite(origin, {
      ...site,
      isTop: false,
    })
  }

  /**
   * Remove connected site
   */
  async removeConnectedSite(origin: string): Promise<void> {
    if (!this.lruCache) return

    const site = this.getConnectedSite(origin)
    if (!site) {
      return
    }

    await this.setSite({
      ...site,
      isConnected: false,
    })
  }

  /**
   * Get sites by default chain
   */
  getSitesByDefaultChain(chain: ChainType): ConnectedSite[] {
    if (!this.lruCache) return []
    return [...this.lruCache.values()].filter((item: ConnectedSite) => item.chain === chain)
  }

  /**
   * Check if origin is internal
   */
  isInternalOrigin(origin: string): boolean {
    return origin === this.internalRequestOrigin
  }

  /**
   * Clear all permissions
   */
  async clearAllPermissions(): Promise<void> {
    await this.mutateAndSync(() => this.lruCache?.reset(), true)
  }

  /**
   * Get permission statistics
   */
  getStats(): { total: number; connected: number; pinned: number } {
    if (!this.lruCache) return { total: 0, connected: 0, pinned: 0 }

    const sites = [...this.lruCache.values()]
    const connectedSites = sites.filter((site: ConnectedSite) => site.isConnected)
    const pinnedSites = connectedSites.filter((site: ConnectedSite) => site.isTop)

    return {
      total: sites.length,
      connected: connectedSites.length,
      pinned: pinnedSites.length,
    }
  }
}
