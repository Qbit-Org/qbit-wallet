import { describe, expect, it, vi } from 'vitest'

import { ConfigService } from '../src/services/config'

const LOCAL_CONFIG = {
  version: '',
  moonPayEnabled: false,
  statusMessage: '',
  endpoint: '',
  chainTip: '',
  disableUtxoTools: true,
}

describe('ConfigService', () => {
  it('returns typed release-local configuration without making a request', async () => {
    const httpClient = {
      get: vi.fn(),
      post: vi.fn(),
    }

    const configService = new ConfigService(httpClient as any)

    const first = await configService.getWalletConfig()
    const second = await configService.getWalletConfig()

    expect(first).toEqual(LOCAL_CONFIG)
    expect(second).toEqual(LOCAL_CONFIG)
    expect(first).not.toBe(second)

    first.statusMessage = 'caller mutation'
    await expect(configService.getWalletConfig()).resolves.toEqual(LOCAL_CONFIG)
    expect(httpClient.get).not.toHaveBeenCalled()
    expect(httpClient.post).not.toHaveBeenCalled()
  })

  it('keeps version details local and leaves updates to the browser store', async () => {
    const httpClient = {
      get: vi.fn(),
      post: vi.fn(),
    }

    const service = new ConfigService(httpClient as any)

    await expect(service.getVersionDetail('1.2.3')).resolves.toEqual({
      version: '1.2.3',
      title: '',
      changelogs: [],
      notice: '',
    })
    expect(httpClient.get).not.toHaveBeenCalled()
    expect(httpClient.post).not.toHaveBeenCalled()
  })
})
