/**
 * Base storage adapter implementation
 */

import { debounce } from 'debounce'
import { PersistentProxyOptions, ProxyStorageAdapter } from './types'

const SAVE_DELAY_MS = 1000
const LOAD_ATTEMPTS = 3
const LOAD_RETRY_DELAY_MS = 100
const TEMPLATE_SAVE_ATTEMPTS = 3
const TEMPLATE_SAVE_RETRY_DELAY_MS = 100

const frozenValues = new WeakSet<object>()

const isPlainContainer = (value: unknown): value is object => {
  if (Array.isArray(value)) return true
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep-copy plain objects and arrays and freeze the copy, so that a write
 * below the top level of a persistent proxy throws instead of changing memory
 * without ever being saved. Values this function already froze are shared.
 */
const toFrozenCopy = <V>(value: V): V => {
  if (!isPlainContainer(value) || frozenValues.has(value)) return value
  const copy = Array.isArray(value)
    ? value.map(toFrozenCopy)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toFrozenCopy(item)]))
  Object.freeze(copy)
  frozenValues.add(copy)
  return copy as V
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const replacedError = (name: string): Error => new Error(`A newer store replaced ${name}; not saved`)

interface KeyOwner {
  save: () => void
  // The owner the key goes back to if this proxy rejects, until it is returned.
  previous?: KeyOwner | undefined
  // Pending until the proxy is returned to its caller or rejects.
  state: 'pending' | 'returned' | 'rejected'
}

export abstract class BaseProxyStorageAdapter implements ProxyStorageAdapter {
  abstract get(key: string): Promise<any>
  abstract set(key: string, value: any): Promise<void>

  // The proxy that owns each storage key. Only the owner saves, so a replaced
  // proxy's pending debounced save cannot write old data over the new store.
  private persistentProxies = new Map<string, KeyOwner>()
  private proxyFlushes = new WeakMap<object, () => Promise<void>>()

  /**
   * Create a persistent proxy that saves top-level writes to storage after a
   * short debounce. Values below the top level are frozen, so a nested write
   * throws: reassign the top-level key instead. A failed read rejects rather
   * than replacing the stored data with the template. When nothing is stored,
   * or on reset, the template is saved before the proxy is returned, retrying
   * a failed write a few times; a write that keeps failing rejects. A proxy
   * that a newer one replaced before it is returned rejects too, without
   * writing its template if it has not yet, as it would never save. The new
   * proxy replaces any earlier one for the same key, which stops saving, so
   * changes it has not saved yet are dropped.
   */
  async createPersistentProxy<T extends object>(
    name: string,
    template: T,
    options: PersistentProxyOptions = {}
  ): Promise<T> {
    const data: Record<string, unknown> = {}
    const debouncedSave = debounce(() => {
      if (this.persistentProxies.get(name) !== owner) return
      this.set(name, { ...data }).catch(error => {
        console.error(`Failed to save preference data for ${name}:`, error)
      })
    }, SAVE_DELAY_MS)
    // Take the key over before anything is read or written, so a save the
    // previous proxy issues from now on cannot land after this one's write.
    const owner: KeyOwner = {
      save: debouncedSave,
      previous: this.persistentProxies.get(name),
      state: 'pending',
    }
    this.persistentProxies.set(name, owner)
    try {
      const stored = options.reset ? undefined : await this.loadStored(name)
      for (const [key, value] of Object.entries(
        stored ? { ...template, ...(stored as object) } : template
      )) {
        data[key] = toFrozenCopy(value)
      }

      if (!stored) {
        await this.saveTemplate(name, { ...data }, owner)
      }
      // A newer proxy took the key during the read or the template write.
      if (this.persistentProxies.get(name) !== owner) throw replacedError(name)
    } catch (error) {
      owner.state = 'rejected'
      // Hand the key back, passing over proxies that rejected, which no
      // caller holds. A returned proxy saves whatever it skipped meanwhile; a
      // pending one has not read its data yet, and goes on as if it had kept
      // the key.
      if (this.persistentProxies.get(name) === owner) {
        let previous = owner.previous
        while (previous?.state === 'rejected') previous = previous.previous
        if (previous) {
          this.persistentProxies.set(name, previous)
          if (previous.state === 'returned') previous.save()
        } else {
          this.persistentProxies.delete(name)
        }
      }
      throw error
    }
    owner.state = 'returned'
    owner.previous = undefined

    // Create proxy to automatically persist changes
    const proxy: object = new Proxy(data, {
      set(target: any, prop: string | symbol, value: any) {
        target[prop] = toFrozenCopy(value)
        debouncedSave()
        return true
      },

      deleteProperty(target: any, prop: string | symbol) {
        if (Reflect.has(target, prop)) {
          Reflect.deleteProperty(target, prop)
          debouncedSave()
        }
        return true
      },
    })

    this.proxyFlushes.set(proxy, () => {
      if (this.persistentProxies.get(name) !== owner) {
        return Promise.reject(replacedError(name))
      }
      debouncedSave.clear()
      return this.set(name, { ...data }).catch(error => {
        // Leave the changes queued for the next debounced save.
        debouncedSave()
        throw error
      })
    })

    return proxy as T
  }

  /**
   * Save a persistent proxy's data now rather than after its debounce. Rejects
   * when the write fails or a newer proxy has replaced it for its key.
   */
  flushPersistentProxy(proxy: object): Promise<void> {
    const flush = this.proxyFlushes.get(proxy)
    if (!flush) {
      return Promise.reject(new Error('Not a persistent proxy of this storage adapter'))
    }
    return flush()
  }

  /**
   * Save the template of a key that holds nothing yet, or that a reset
   * replaces, retrying a failed write a few times, so that one failed write
   * does not stop the service from starting. Every attempt writes the same
   * value, so an attempt that failed but still landed does no harm. Nothing is
   * written, and retrying stops, once a newer proxy owns the key, so this
   * template cannot land over that proxy's data. Rejects with the last write
   * error, or without writing when a newer proxy took the key during the read.
   */
  private async saveTemplate(name: string, template: object, owner: object): Promise<void> {
    if (this.persistentProxies.get(name) !== owner) {
      throw replacedError(name)
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await this.set(name, template)
        return
      } catch (error) {
        if (attempt >= TEMPLATE_SAVE_ATTEMPTS) throw error
        await delay(TEMPLATE_SAVE_RETRY_DELAY_MS * attempt)
        if (this.persistentProxies.get(name) !== owner) throw error
      }
    }
  }

  /**
   * Read the stored value, retrying a failed read a few times. A read that
   * keeps failing rejects: the data is unknown, not absent.
   */
  private async loadStored(name: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.get(name)
      } catch (error) {
        if (attempt >= LOAD_ATTEMPTS) {
          const failure = new Error(`Failed to load stored data for ${name}`)
          ;(failure as { cause?: unknown }).cause = error
          throw failure
        }
        await delay(LOAD_RETRY_DELAY_MS * attempt)
      }
    }
  }
}
