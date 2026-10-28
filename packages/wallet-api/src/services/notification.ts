/**
 * Notification related API methods
 */

import { NotificationListItem } from '@qbit/wallet-shared'
import type { BaseHttpClient } from '../client/http-client'

export class NotificationService {
  constructor(httpClient: BaseHttpClient) {
    void httpClient
  }

  // ========================================
  // Notification related
  // ========================================

  /**
   * Get notification list
   */
  async getList(): Promise<{
    list: NotificationListItem[]
    total: number
  }> {
    return { list: [], total: 0 }
  }

  async read(notificationId: string): Promise<{
    success: boolean
  }> {
    void notificationId
    return { success: true }
  }

  async readAll(notificationIds: string[]): Promise<{
    success: boolean
  }> {
    void notificationIds
    return { success: true }
  }
}
