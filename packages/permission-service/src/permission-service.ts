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
 * Why `site` cannot be stored, or undefined when it can. Its origin and chain
 * must be non-empty.
 */
function siteProblem(site: unknown): string | undefined {
  if (!isObject(site)) return 'is not an object'
  for (const [field, type] of Object.entries(REQUIRED_SITE_FIELDS)) {
    if (!hasType(site[field], type)) return `has no valid ${field}`
  }
  for (const [field, type] of Object.entries(OPTIONAL_SITE_FIELDS)) {
    if (site[field] !== undefined && !hasType(site[field], type)) return `has an invalid ${field}`
  }
  if (site.origin === '' || site.chain === '') return 'has an empty origin or chain'
  return undefined
}

type Candidate = { site: unknown } | { problem: string }

/**
 * The candidates, most recently used first, split into the sites that can be
 * stored and why each other one cannot. Every copy of an origin that appears
 * more than once is dropped, since which of them holds the grant is unclear.
 */
function splitSites(candidates: Candidate[]): { sites: ConnectedSite[]; dropped: string[] } {
  const checked = candidates.map(candidate =>
    'problem' in candidate
      ? candidate
      : { site: candidate.site, problem: siteProblem(candidate.site) }
  )
  const copies = new Map<unknown, number>()
  for (const candidate of checked) {
    if ('site' in candidate && !candidate.problem) {
      const { origin } = candidate.site as ConnectedSite
      copies.set(origin, (copies.get(origin) ?? 0) + 1)
    }
  }

  const sites: ConnectedSite[] = []
  const dropped: string[] = []
  for (const [index, candidate] of checked.entries()) {
    if (candidate.problem) {
      dropped.push(`site ${index} ${candidate.problem}`)
    } else if ('site' in candidate) {
      const site = candidate.site as ConnectedSite
      if (copies.get(site.origin) === 1) sites.push(site)
      else dropped.push(`site ${index} shares its origin with another site`)
    }
  }
  return { sites, dropped }
}

const isOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

/**
 * Read one lru-cache 6 dump entry as a site. 1.0.6 checked a grant by the key
 * it was kept under, which its updateConnectSite could leave different from
 * the site's own origin; the site is then kept under that key when it is an
 * origin, which grants nothing 1.0.6 did not.
 */
function dumpEntrySite(entry: unknown): Candidate {
  // The wallet never gave a site an expiry, so every entry it wrote has e: 0.
  if (!isObject(entry) || (entry.e !== 0 && entry.e !== undefined)) {
    return { problem: 'is not an lru-cache entry the wallet writes' }
  }
  if (!isObject(entry.v)) return { problem: 'has no site' }
  if (entry.k === entry.v.origin) return { site: entry.v }
  if (!isOrigin(entry.k)) return { problem: 'is kept under a key that is not an origin' }
  return { site: { ...entry.v, origin: entry.k } }
}

/**
 * The sites a stored `permission` record holds, most recently used first, and
 * why each site left out was dropped; or why the whole record was not read.
 * Reads a PermissionStore and the lru-cache 6 dump that 1.0.6 and earlier
 * wrote (LRUCacheDumpStore), which wins when a record has both. A malformed
 * site is dropped on its own; a record that is not an object, has a version
 * this release does not know or has no list of sites is rejected whole rather
 * than read as some other set of grants.
 */
function parseStore(
  stored: unknown
): { sites: ConnectedSite[]; dropped: string[] } | { problem: string } {
  if (stored === undefined || stored === null) return { sites: [], dropped: [] }
  if (!isObject(stored)) return { problem: 'the record is not an object' }

  if ('version' in stored && stored.version !== STORE_VERSION) {
    return { problem: `version ${JSON.stringify(stored.version)} is not one this release reads` }
  }

  if ('dumpCache' in stored) {
    // 1.0.6 and earlier write their dump next to the keys they do not know, and
    // this release never writes one. A version 1 record with a dump was last
    // written by such a release after a downgrade: the dump is the latest
    // state, and the sites beside it are stale grants that release never showed.
    const { dumpCache } = stored
    if (!Array.isArray(dumpCache)) return { problem: 'the lru-cache dump is not a list' }
    return splitSites(dumpCache.map(dumpEntrySite))
  }
  if ('version' in stored) {
    if (!Array.isArray(stored.sites)) return { problem: 'the record has no list of sites' }
    return splitSites(stored.sites.map(site => ({ site })))
  }
  return { problem: 'the record has neither a version nor an lru-cache dump' }
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

      // Fail closed: no site keeps a grant read from a record, or an entry, the
      // service does not understand. The record stays as it is until the next
      // write replaces it.
      const parsed = parseStore(await this.storage.get(this.storageKey))
      if ('problem' in parsed) {
        this.logger.error(
          'PermissionService: the stored site permissions were not loaded, so sites must connect again:',
          parsed.problem
        )
      } else {
        for (const reason of parsed.dropped) {
          this.logger.error(
            'PermissionService: a stored site permission was not loaded, so that site must connect again:',
            reason
          )
        }
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
    await this.clearSites()
  }

  /**
   * The sites, or a rejection when init has not loaded them: a change made
   * then could not be stored, and must not look as if it had been.
   */
  private loadedSites(): Map<string, ConnectedSite> {
    if (!this.sites) {
      throw new Error('PermissionService: not initialized, so the change was not stored')
    }
    return this.sites
  }

  /**
   * Remove every site and store the empty record, whether or not init loaded
   * the stored one, so no grant is left on disk for the next start. Rejects,
   * changing nothing, when the record cannot be written.
   */
  private async clearSites(): Promise<void> {
    if (!this.storage) {
      throw new Error('PermissionService: Storage adapter is required')
    }
    const previousSites = this.sites
    this.sites = new Map()
    try {
      await this.storage.set(this.storageKey, this.toStore())
    } catch (error) {
      this.sites = previousSites
      throw error
    }
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
  private async mutateAndSync(mutate: () => void): Promise<void> {
    const previousSites = new Map(this.loadedSites())
    mutate()
    try {
      // Never keep a site the next start would drop.
      const [problem] = splitSites(this.recentFirst().map(site => ({ site }))).dropped
      if (problem) {
        throw new Error(`PermissionService: ${problem}`)
      }
      await this.sync()
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
    if (!this.loadedSites().has(origin)) return
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
    if (!this.loadedSites().has(origin)) return

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
    this.loadedSites()
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
    this.loadedSites()
    const site = this.getConnectedSite(origin)
    if (!site) return

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
    this.loadedSites()
    const site = this.getConnectedSite(origin)
    if (!site) return

    await this.updateConnectSite(origin, {
      ...site,
      isTop: false,
    })
  }

  /**
   * Remove connected site
   */
  async removeConnectedSite(origin: string): Promise<void> {
    this.loadedSites()
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
    await this.clearSites()
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
