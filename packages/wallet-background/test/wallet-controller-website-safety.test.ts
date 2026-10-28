import { getWebsiteSafetyWarning } from '@qbit/phishing-detect'
import { WebsiteVerdictStatus, createClearWebsiteResult } from '@qbit/wallet-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import walletController from '../src/controllers/wallet'
import { phishingDetectService } from '../src/services'

describe('WalletController website safety', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the local detector and preserves the explicit verdict', async () => {
    const localResult = createClearWebsiteResult('example.com')
    const detector = vi.spyOn(phishingDetectService, 'checkWebsite').mockReturnValue(localResult)

    await expect(walletController.checkWebsite('https://example.com')).resolves.toEqual(
      localResult
    )
    expect(detector).toHaveBeenCalledWith('https://example.com')
  })

  it('fails closed to unverified when the local detector throws', async () => {
    vi.spyOn(phishingDetectService, 'checkWebsite').mockImplementation(() => {
      throw new Error('detector unavailable')
    })

    const result = await walletController.checkWebsite('https://example.com')

    expect(result.verdict).toEqual({
      status: WebsiteVerdictStatus.UNVERIFIED,
      reason: 'detector-failure',
      warning: getWebsiteSafetyWarning('detector-failure'),
    })
    expect(result.allowQuickMultiSign).toBe(false)
  })
})
