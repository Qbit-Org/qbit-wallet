import { ChainType } from '@qbit/wallet-types'
import {
  ContactBookItem,
  ContactBookStore,
  ContactBookConfig,
  StorageAdapter,
  Logger,
} from './types'
import { ProxyStorageAdapter } from '@qbit/wallet-storage'

// Default no-op logger
const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Helper function to generate a composite key from address and chain
 */
const getCompositeKey = (address: string, chain: ChainType): string => {
  return `${address}_${chain}`
}

/**
 * Universal contact book management with multi-chain support
 */
export class ContactBookService {
  private store: ContactBookStore = {}
  private storage: ProxyStorageAdapter = undefined as any
  private storageKey: string = 'contactBook'
  private logger: Logger = defaultLogger
  private autoSync: boolean = true
  private initialized = false
  private pendingCommit: Promise<void> = Promise.resolve()

  constructor() {}

  /**
   * Initialize the contact book - loads data from storage
   */
  async init(config: ContactBookConfig): Promise<void> {
    if (this.initialized) {
      return
    }

    if (config.storage) {
      this.storage = config.storage
    }

    if (config.storageKey) {
      this.storageKey = config.storageKey
    }

    if (typeof config.autoSync === 'boolean') {
      this.autoSync = config.autoSync
    }

    if (config.logger) {
      this.logger = config.logger
    }

    this.logger.debug('Initializing contact book...')

    try {
      // Load existing data from storage
      const storedData = await this.storage.get(this.storageKey)
      this.store = storedData || {}

      // Rebuild contact store with composite keys if needed
      await this.rebuildContactStore()

      this.initialized = true
      this.logger.debug('Contact book initialization completed')
    } catch (error) {
      this.logger.error('Contact book initialization failed:', error)
      throw error
    }
  }

  resetAllData = (): Promise<void> => {
    return this.enqueue(async () => {
      await this.storage.set(this.storageKey, {})
      this.store = {}
    })
  }

  /**
   * Normalize stored contacts to composite address-and-chain keys.
   */
  private async rebuildContactStore(): Promise<void> {
    try {
      this.logger.debug('Rebuilding contact store to use composite keys...')

      // Extract all valid contacts
      const validContacts: ContactBookItem[] = []

      Object.entries(this.store).forEach(([, contact]) => {
        if (contact && contact.address && contact.chain) {
          validContacts.push({ ...contact })
        }
      })

      this.logger.debug(`Found ${validContacts.length} valid contacts`)

      // Clear current store
      this.store = {}

      // Add contacts back using composite keys
      const processedKeys = new Set<string>()

      validContacts.forEach(contact => {
        const compositeKey = getCompositeKey(contact.address, contact.chain)

        // Avoid duplicates
        if (!processedKeys.has(compositeKey)) {
          this.store[compositeKey] = { ...contact }
          processedKeys.add(compositeKey)
        }
      })

      this.logger.debug(`Rebuilt contact store with ${Object.keys(this.store).length} contacts`)

      // Save the rebuilt store
      if (this.autoSync) {
        await this.syncToStorage()
      }
    } catch (error) {
      this.logger.error('Failed to rebuild contact store:', error)
      throw error
    }
  }

  /**
   * Sync a store to storage
   */
  private async syncToStorage(store: ContactBookStore = this.store): Promise<void> {
    try {
      await this.storage.set(this.storageKey, store)
    } catch (error) {
      this.logger.error('Failed to sync to storage:', error)
      throw error
    }
  }

  /**
   * Run storage tasks one at a time, in call order.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.pendingCommit.then(task)
    this.pendingCommit = run.catch(() => undefined)
    return run
  }

  /**
   * Replace the store with the one `change` builds, once that one is saved, so
   * a failed write rejects and leaves the store matching what is on disk.
   * `change` returns undefined when there is nothing to change.
   */
  private commit(change: (store: ContactBookStore) => ContactBookStore | undefined): Promise<void> {
    return this.enqueue(async () => {
      const next = change(this.store)
      if (!next) return

      if (this.autoSync) {
        await this.syncToStorage(next)
      }
      this.store = next
    })
  }

  /**
   * Ensure initialization before operations
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ContactBook not initialized. Call init() first.')
    }
  }

  /**
   * Get contact by address (returns first match across all chains)
   */
  getContactByAddress(address: string): ContactBookItem | undefined {
    this.ensureInitialized()

    // Search for any contact with this address, returning the first match
    const allContacts = Object.entries(this.store)

    for (const [key, contact] of allContacts) {
      if (contact && key.startsWith(address + '_')) {
        return contact
      }
    }

    return undefined
  }

  /**
   * Get contact by address and chain
   */
  getContactByAddressAndChain(address: string, chain: ChainType): ContactBookItem | undefined {
    this.ensureInitialized()

    // Use composite key to retrieve contact
    const key = getCompositeKey(address, chain)
    return this.store[key]
  }

  /**
   * Remove contact
   */
  async removeContact(address: string, chain: ChainType): Promise<void> {
    this.ensureInitialized()

    // Use composite key to remove contact
    const key = getCompositeKey(address, chain)

    await this.commit(store => {
      const contact = store[key]

      if (!contact) return undefined

      if (contact.isAlias) {
        // If it's also an alias, just remove the contact flag
        return { ...store, [key]: { ...contact, isContact: false } }
      }
      // Remove completely if it's not an alias
      const next = { ...store }
      delete next[key]
      return next
    })
  }

  /**
   * Update or add contact
   */
  async updateContact(data: ContactBookItem): Promise<void> {
    this.ensureInitialized()

    // Use composite key to store contact
    const compositeKey = getCompositeKey(data.address, data.chain)

    // Store contact using composite key
    await this.commit(store => ({
      ...store,
      [compositeKey]: {
        name: data.name,
        address: data.address,
        chain: data.chain,
        isContact: true,
        isAlias: data.isAlias || false,
        sortIndex: data.sortIndex || 0,
      },
    }))
  }

  /**
   * Add contact (alias for updateContact)
   */
  async addContact(data: ContactBookItem): Promise<void> {
    return this.updateContact(data)
  }

  /**
   * Save contacts order
   */
  async saveContactsOrder(contacts: ContactBookItem[]): Promise<void> {
    this.ensureInitialized()

    await this.commit(store => {
      const next = { ...store }
      contacts.forEach((contact, index) => {
        const key = getCompositeKey(contact.address, contact.chain)
        const existingContact = next[key]

        if (existingContact) {
          next[key] = { ...existingContact, sortIndex: index }
        }
      })
      return next
    })
  }

  /**
   * List all contacts (sorted by sortIndex)
   */
  listContacts(): ContactBookItem[] {
    this.ensureInitialized()

    const list = Object.values(this.store)
    const contacts = list.filter((item): item is ContactBookItem => !!item?.isContact) || []

    return contacts.sort((a, b) => {
      if (a.sortIndex !== undefined && b.sortIndex !== undefined) {
        return a.sortIndex - b.sortIndex
      }
      if (a.sortIndex !== undefined) {
        return -1
      }
      if (b.sortIndex !== undefined) {
        return 1
      }
      return 0
    })
  }

  /**
   * List all aliases
   */
  listAlias(): (ContactBookItem | undefined)[] {
    this.ensureInitialized()
    return Object.values(this.store).filter(item => item?.isAlias)
  }

  /**
   * Update alias
   */
  async updateAlias(data: { address: string; name: string; chain: ChainType }): Promise<void> {
    this.ensureInitialized()

    const key = getCompositeKey(data.address, data.chain)

    await this.commit(store => {
      const existingContact = store[key]

      if (existingContact) {
        // Update existing contact with alias information
        return {
          ...store,
          [key]: {
            ...existingContact,
            name: data.name,
            address: data.address,
            chain: data.chain,
            isAlias: true,
          },
        }
      }
      // Create new alias entry
      return {
        ...store,
        [key]: {
          name: data.name,
          address: data.address,
          chain: data.chain,
          isAlias: true,
          isContact: false,
        },
      }
    })
  }

  /**
   * Add alias (alias for updateAlias)
   */
  async addAlias(data: { address: string; name: string; chain: ChainType }): Promise<void> {
    return this.updateAlias(data)
  }

  /**
   * Remove alias
   */
  async removeAlias(address: string, chain: ChainType): Promise<void> {
    this.ensureInitialized()

    const key = getCompositeKey(address, chain)

    await this.commit(store => {
      const contact = store[key]

      if (!contact) return undefined

      if (contact.isContact) {
        // If it's also a contact, just remove the alias flag
        return { ...store, [key]: { ...contact, isAlias: false } }
      }
      // Remove completely if it's not a contact
      const next = { ...store }
      delete next[key]
      return next
    })
  }

  /**
   * Get contacts as a map (for easier lookup)
   */
  getContactsByMap(): Record<string, ContactBookItem> {
    this.ensureInitialized()

    return Object.values(this.store)
      .filter((item): item is ContactBookItem => !!item?.isContact)
      .reduce(
        (res, item) => ({
          ...res,
          [getCompositeKey(item.address, item.chain)]: item,
        }),
        {} as Record<string, ContactBookItem>
      )
  }

  /**
   * Manual sync to storage (useful when autoSync is disabled)
   */
  async sync(): Promise<void> {
    this.ensureInitialized()
    await this.enqueue(() => this.syncToStorage())
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    this.ensureInitialized()

    await this.commit(() => ({}))
  }

  /**
   * Get raw store data (for debugging or migration)
   */
  getRawStore(): ContactBookStore {
    this.ensureInitialized()
    return { ...this.store }
  }
}
