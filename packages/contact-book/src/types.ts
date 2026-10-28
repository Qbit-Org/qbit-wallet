import { ChainType } from '@qbit/wallet-types'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'

/**
 * Contact book item interface
 */
export interface ContactBookItem {
  name: string
  address: string
  chain: ChainType
  isAlias: boolean
  isContact: boolean
  sortIndex?: number
}

/**
 * UI contact book item interface (simplified for UI components)
 */
export interface UIContactBookItem {
  name: string
  address: string
}

/**
 * Contact book store type - maps composite keys to contact items
 */
export type ContactBookStore = Record<string, ContactBookItem | undefined>

/**
 * Storage adapter interface - abstracts different storage backends
 */
export interface StorageAdapter {
  /**
   * Get value by key
   */
  get(key: string): Promise<any>

  /**
   * Set value by key
   */
  set(key: string, value: any): Promise<void>

  /**
   * Remove value by key
   */
  remove(key: string): Promise<void>

  /**
   * Clear all data
   */
  clear?(): Promise<void>
}

/**
 * Logger interface - allows custom logging implementations
 */
export interface Logger {
  debug(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
}

/**
 * Contact book configuration options
 */
export interface ContactBookConfig {
  /**
   * Storage adapter instance
   */
  storage: ProxyStorageAdapter

  /**
   * Storage key name (default: 'contactBook')
   */
  storageKey?: string

  /**
   * Logger instance (optional)
   */
  logger?: Logger

  /**
   * Auto-sync changes to storage (default: true)
   */
  autoSync?: boolean
}
