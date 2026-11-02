import { ProxyStorageAdapter } from '@qbit/wallet-storage'
import { ChainType } from '@qbit/wallet-types'

// One entry of lru-cache 6's dump, the form 1.0.6 and earlier stored site
// permissions in: key, value and expiry time (0 for none).
export interface LRUEntry<K, V> {
  k: K
  v: V
  e: number
}

/**
 * Site connection information
 */
export interface ConnectedSite {
  origin: string
  icon: string
  name: string
  chain: ChainType
  e?: number
  isSigned: boolean
  isTop: boolean
  order?: number
  isConnected: boolean
  allowQuickMultiSign?: boolean
}

/**
 * Stored site permissions, most recently used site first. The version changes
 * with the shape, so a release that does not know a record's version rejects
 * it instead of reading it as some other set of grants.
 */
export interface PermissionStore {
  version: 1
  sites: ConnectedSite[]
}

/**
 * What 1.0.6 and earlier stored: lru-cache 6's dump, most recently used site
 * first. Read once and replaced by a {@link PermissionStore} on the next write.
 */
export interface LRUCacheDumpStore {
  dumpCache: LRUEntry<string, ConnectedSite>[]
}

/**
 * Storage adapter interface
 */
export interface StorageAdapter {
  get(key: string): Promise<any>
  set(key: string, value: any): Promise<void>
}

/**
 * Logger interface
 */
export interface Logger {
  log(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
  debug?(...args: any[]): void
}

/**
 * Permission service configuration
 */
export interface PermissionServiceConfig {
  storage: ProxyStorageAdapter
  storageKey?: string
  logger?: Logger
  autoSync?: boolean
  internalRequestOrigin?: string
}

/**
 * Default logger implementation
 */
export const defaultLogger: Logger = {
  log: (...args: any[]) => console.log('[PermissionService]', ...args),
  warn: (...args: any[]) => console.warn('[PermissionService]', ...args),
  error: (...args: any[]) => console.error('[PermissionService]', ...args),
  debug: (...args: any[]) => console.debug('[PermissionService]', ...args),
}
