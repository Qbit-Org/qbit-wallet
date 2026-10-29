import type { ConnectedSite, PermissionStore, PermissionServiceConfig, Logger } from './types'
import { defaultLogger } from './types'
import { ChainType } from '@qbit/wallet-types'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'

const STORE_VERSION: PermissionStore['version'] = 1

// The most sites kept. Using one more drops the least recently used.
const MAX_SITES = 1000

type FieldType = 'string' | 'boolean' | 'number'

const REQUIRED_SITE_FIELDS: Record<string, FieldType> = {
  origin: 'string',
  name: 'string',
  icon: 'string',
  chain: 'string',
  isSigned: 'boolean',
  isTop: 'boolean',
  isConnected: 'boolean',
}

const OPTIONAL_SITE_FIELDS: Record<string, FieldType> = {
  e: 'number',
  order: 'number',
  allowQuickMultiSign: 'boolean',
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasType = (value: unknown, type: FieldType): boolean =>
  type === 'number' ? Number.isFinite(value) : typeof value === type

/**
 * Why `sites` is not a list of sites that can be stored, or undefined when it
 * is. Origins and chains must be non-empty and each origin appears once.
 */
function sitesProblem(sites: unknown[]): string | undefined {
  const origins = new Set<unknown>()
  for (const [index, site] of sites.entries()) {
    if (!isObject(site)) return `site ${index} is not an object`
    for (const [field, type] of Object.entries(REQUIRED_SITE_FIELDS)) {
      if (!hasType(site[field], type)) return `site ${index} has no valid ${field}`
    }
    for (const [field, type] of Object.entries(OPTIONAL_SITE_FIELDS)) {
      if (site[field] !== undefined && !hasType(site[field], type)) {
        return `site ${index} has an invalid ${field}`
      }
    }
    if (site.origin === '' || site.chain === '') return `site ${index} has an empty origin or chain`
    if (origins.has(site.origin)) return `site ${index} repeats an earlier origin`
    origins.add(site.origin)
  }
  return undefined
}

/**
 * The sites a stored `permission` record holds, most recently used first, or
 * why it was not read. Reads a PermissionStore and the lru-cache 6 dump that
 * 1.0.6 and earlier wrote (LRUCacheDumpStore), which wins when a record has
 * both. Anything else, including a version this release does not know, is
 * rejected rather than read as some other set of grants.
 */
function parseStore(stored: unknown): { sites: ConnectedSite[] } | { problem: string } {
  if (stored === undefined || stored === null) return { sites: [] }
  if (!isObject(stored)) return { problem: 'the record is not an object' }

  if ('version' in stored && stored.version !== STORE_VERSION) {
    return { problem: `version ${JSON.stringify(stored.version)} is not one this release reads` }
  }

  let sites: unknown[]
  if ('dumpCache' in stored) {
    // 1.0.6 and earlier write their dump next to the keys they do not know, and
    // this release never writes one. A version 1 record with a dump was last
    // written by such a release after a downgrade: the dump is the latest
    // state, and the sites beside it are stale grants that release never showed.
    const { dumpCache } = stored
    if (!Array.isArray(dumpCache)) return { problem: 'the lru-cache dump is not a list' }
    sites = []
    for (const [index, entry] of dumpCache.entries()) {
      // The wallet never gave a site an expiry, so every entry it wrote has
      // e: 0, and each is kept under its site's origin.
      if (!isObject(entry) || (entry.e !== 0 && entry.e !== undefined)) {
        return { problem: `lru-cache dump entry ${index} is not one the wallet writes` }
      }
      if (!isObject(entry.v) || entry.k !== entry.v.origin) {
        return { problem: `lru-cache dump entry ${index} is not kept under its site's origin` }
      }
      sites.push(entry.v)
    }
  } else if ('version' in stored) {
    if (!Array.isArray(stored.sites)) return { problem: 'the record has no list of sites' }
    sites = stored.sites
  } else {
    return { problem: 'the record has neither a version nor an lru-cache dump' }
  }

  const problem = sitesProblem(sites)
  return problem ? { problem } : { sites: sites as ConnectedSite[] }
}

/**
 * Cross-platform permission service for managing dApp connections
 */
export class PermissionService {
  // Sites by origin, least recently used first: a Map keeps insertion order,
  // so using a site deletes and adds it again.
  private sites: Map<string, ConnectedSite> | undefined
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

      const parsed = parseStore(await this.storage.get(this.storageKey))
      if ('problem' in parsed) {
        // Fail closed: no site keeps a grant read from a record the service
        // does not understand. The record stays as it is until the next write
        // replaces it.
        this.logger.error(
          'PermissionService: the stored site permissions were not loaded, so sites must connect again:',
          parsed.problem
        )
      }
      this.sites = new Map()
      this.load('sites' in parsed ? parsed.sites : [])

      this.logger.debug?.('PermissionService initialized with', this.sites.size, 'cached sites')
    } catch (error) {
      this.logger.error('Failed to initialize PermissionService:', error)
      throw error
    }
  }

  resetAllData = async (): Promise<void> => {
    await this.mutateAndSync(() => this.sites?.clear(), true)
  }

  /**
   * Sites, most recently used first: the order they are stored in.
   */
  private recentFirst(): ConnectedSite[] {
    return [...(this.sites?.values() || [])].reverse()
  }

  /**
   * Make `site` the most recently used, dropping the least recently used
   * beyond MAX_SITES.
   */
  private put(site: ConnectedSite): void {
    if (!this.sites) return
    this.sites.delete(site.origin)
    this.sites.set(site.origin, site)
    for (const origin of this.sites.keys()) {
      if (this.sites.size <= MAX_SITES) break
      this.sites.delete(origin)
    }
  }

  /**
   * The site for `origin`, which becomes the most recently used.
   */
  private use(origin: string): ConnectedSite | undefined {
    const site = this.sites?.get(origin)
    if (site) this.put(site)
    return site
  }

  /**
   * Replace every site with `sites`, most recently used first.
   */
  private load(sites: ConnectedSite[]): void {
    this.sites?.clear()
    for (const site of [...sites].reverse()) this.put(site)
  }

  private toStore(): PermissionStore {
    return { version: STORE_VERSION, sites: this.recentFirst() }
  }

  /**
   * Sync cache to storage
   */
  private async sync(): Promise<void> {
    if (!this.autoSync || !this.sites) return

    try {
      await this.storage.set(this.storageKey, this.toStore())
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
    if (!this.sites) return

    const previousSites = new Map(this.sites)
    mutate()
    try {
      // Never keep a change the next start would reject the whole record for.
      const problem = sitesProblem(this.recentFirst())
      if (problem) {
        throw new Error(`PermissionService: ${problem}`)
      }
      if (forceSync) {
        await this.storage.set(this.storageKey, this.toStore())
      } else {
        await this.sync()
      }
    } catch (error) {
      this.sites = previousSites
      throw error
    }
  }

  /**
   * Get site without updating LRU order
   */
  getWithoutUpdate(key: string): ConnectedSite | undefined {
    return this.sites?.get(key)
  }

  /**
   * Get site information
   */
  getSite(origin: string): ConnectedSite | undefined {
    return this.use(origin)
  }

  /**
   * Set site information
   */
  async setSite(site: ConnectedSite): Promise<void> {
    await this.mutateAndSync(() => this.put(site))
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
      this.put({
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
    if (!this.sites?.has(origin)) return
    await this.mutateAndSync(() => this.use(origin))
  }

  /**
   * Update connected site
   */
  async updateConnectSite(
    origin: string,
    value: Partial<ConnectedSite>,
    partialUpdate?: boolean
  ): Promise<void> {
    if (!this.sites?.has(origin)) return

    // The site stays under `origin`, which is what it is stored and read by.
    await this.mutateAndSync(() => {
      if (partialUpdate) {
        const existingValue = this.sites!.get(origin)
        this.put({ ...existingValue, ...value, origin } as ConnectedSite)
      } else {
        this.put({ ...value, origin } as ConnectedSite)
      }
    })
  }

  /**
   * Check if origin has permission
   */
  hasPermission(origin: string, chain?: ChainType): boolean {
    const site = this.sites?.get(origin)
    return Boolean(site?.isConnected && (chain === undefined || site.chain === chain))
  }

  /**
   * Set recent connected sites order
   */
  async setRecentConnectedSites(sites: ConnectedSite[]): Promise<void> {
    if (!this.sites) return

    const disconnectedSites = this.recentFirst().filter((item: ConnectedSite) => !item.isConnected)
    await this.mutateAndSync(() => this.load(sites.concat(disconnectedSites)))
  }

  /**
   * Get recent connected sites (ordered with pinned sites first)
   */
  getRecentConnectedSites(): ConnectedSite[] {
    const sites = this.recentFirst().filter((item: ConnectedSite) => item.isConnected)
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
    return this.recentFirst().filter((item: ConnectedSite) => item.isConnected)
  }

  /**
   * Get connected site by key
   */
  getConnectedSite(key: string): ConnectedSite | undefined {
    const site = this.use(key)
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
    if (!site || !this.sites) return

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
    if (!site || !this.sites) return

    await this.updateConnectSite(origin, {
      ...site,
      isTop: false,
    })
  }

  /**
   * Remove connected site
   */
  async removeConnectedSite(origin: string): Promise<void> {
    if (!this.sites) return

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
    return this.recentFirst().filter((item: ConnectedSite) => item.chain === chain)
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
    await this.mutateAndSync(() => this.sites?.clear(), true)
  }

  /**
   * Get permission statistics
   */
  getStats(): { total: number; connected: number; pinned: number } {
    if (!this.sites) return { total: 0, connected: 0, pinned: 0 }

    const sites = [...this.sites.values()]
    const connectedSites = sites.filter((site: ConnectedSite) => site.isConnected)
    const pinnedSites = connectedSites.filter((site: ConnectedSite) => site.isTop)

    return {
      total: sites.length,
      connected: connectedSites.length,
      pinned: pinnedSites.length,
    }
  }
}
