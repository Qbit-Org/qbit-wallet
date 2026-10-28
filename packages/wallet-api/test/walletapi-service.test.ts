import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WalletApiService } from '../src/walletapi-service'

function createStorage() {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    createPersistentProxy: vi.fn(),
  }
}

function createHttpClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    setBaseURL: vi.fn(),
    setHeaders: vi.fn(),
  }
}

describe('WalletApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('init clears cached service state without creating an identifier or setting headers', async () => {
    const storage = createStorage()
    const httpClient = createHttpClient()

    const service = new WalletApiService()
    await service.init({
      storage: storage as any,
      httpClient: httpClient as any,
      endpoint: 'https://e.test',
    })

    expect(storage.set).toHaveBeenCalledWith('openapi', null)
    expect(storage.createPersistentProxy).not.toHaveBeenCalled()
    expect(httpClient.setBaseURL).toHaveBeenCalledWith('https://e.test')
    expect(httpClient.setHeaders).not.toHaveBeenCalled()
  })

  it('setEndpoint only updates the base URL', async () => {
    const storage = createStorage()
    const httpClient = createHttpClient()

    const service = new WalletApiService()
    await service.init({
      storage: storage as any,
      httpClient: httpClient as any,
      endpoint: 'https://e.test',
    })
    httpClient.setHeaders.mockClear()

    await service.setEndpoint('https://another.test')

    expect(httpClient.setBaseURL).toHaveBeenLastCalledWith('https://another.test')
    expect(httpClient.setHeaders).not.toHaveBeenCalled()
  })

  it('resetAllData clears cached service state without changing caller headers', async () => {
    const storage = createStorage()
    const httpClient = createHttpClient()

    const service = new WalletApiService()
    await service.init({
      storage: storage as any,
      httpClient: httpClient as any,
      endpoint: 'https://e.test',
    })
    storage.set.mockClear()
    httpClient.setHeaders.mockClear()

    await service.resetAllData()

    expect(storage.set).toHaveBeenCalledTimes(1)
    expect(storage.set).toHaveBeenCalledWith('openapi', null)
    expect(storage.createPersistentProxy).not.toHaveBeenCalled()
    expect(httpClient.setHeaders).not.toHaveBeenCalled()
  })

  it('requires storage before touching the client', async () => {
    const httpClient = createHttpClient()
    const service = new WalletApiService()

    await expect(service.init({ httpClient: httpClient as any })).rejects.toThrow(
      'WalletApiService: Storage adapter is required'
    )

    expect(httpClient.setBaseURL).not.toHaveBeenCalled()
    expect(httpClient.setHeaders).not.toHaveBeenCalled()
  })

  it('requires an explicitly configured endpoint', async () => {
    const storage = createStorage()
    const httpClient = createHttpClient()
    const service = new WalletApiService()

    await expect(
      service.init({ storage: storage as any, httpClient: httpClient as any })
    ).rejects.toThrow('WalletApiService: Endpoint is required')

    expect(httpClient.setBaseURL).not.toHaveBeenCalled()
  })
})
