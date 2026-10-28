/**
 * Utility and tool related API methods
 */

import type { BaseHttpClient } from '../client/http-client'
import type { Announcement } from '../types'

export class UtilityService {
  constructor(private readonly httpClient: BaseHttpClient) {}

  /**
   * Get block activity information
   */
  async getBlockActiveInfo(): Promise<{ allTransactions: number; allAddrs: number }> {
    return this.httpClient.get('/v5/default/block-active-info')
  }

  async getAnnouncements(
    cursor: number,
    size: number
  ): Promise<{ hasMore: boolean; list: Announcement[] }> {
    void cursor
    void size
    return { hasMore: false, list: [] }
  }
}
