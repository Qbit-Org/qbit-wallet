import { describe, expect, it, vi } from 'vitest'

import { NotificationService } from '../src/services/notification'

describe('NotificationService', () => {
  it('keeps notification content and read state local', async () => {
    const httpClient = {
      get: vi.fn(),
      post: vi.fn(),
    }
    const service = new NotificationService(httpClient as any)

    await expect(service.getList()).resolves.toEqual({ list: [], total: 0 })
    await expect(service.read('notification-id')).resolves.toEqual({ success: true })
    await expect(service.readAll(['notification-id'])).resolves.toEqual({ success: true })
    expect(httpClient.get).not.toHaveBeenCalled()
    expect(httpClient.post).not.toHaveBeenCalled()
  })
})
