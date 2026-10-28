import { describe, expect, it, vi } from 'vitest'

import { UtilityService } from '../src/services/utility'

describe('UtilityService', () => {
  it('does not expose a remote website-safety method', () => {
    const httpClient = {
      get: vi.fn(),
      post: vi.fn(),
    }

    const service = new UtilityService(httpClient as any)

    expect('checkWebsite' in service).toBe(false)
    expect(httpClient.get).not.toHaveBeenCalled()
    expect(httpClient.post).not.toHaveBeenCalled()
  })

  it('returns the local empty announcement list', async () => {
    const httpClient = {
      get: vi.fn(),
      post: vi.fn(),
    }

    const service = new UtilityService(httpClient as any)

    await expect(service.getAnnouncements(10, 20)).resolves.toEqual({ hasMore: false, list: [] })
    expect(httpClient.get).not.toHaveBeenCalled()
    expect(httpClient.post).not.toHaveBeenCalled()
  })
})
