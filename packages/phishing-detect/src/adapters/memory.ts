/**
 * Memory adapter for phishing service
 */

import type { PhishingAdapter } from '../types'

export class MemoryAdapter implements PhishingAdapter {
  private storage = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.storage.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.storage.set(key, value)
  }
}
