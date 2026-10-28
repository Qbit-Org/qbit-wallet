/**
 * Configuration and utility API methods
 */

import type { WalletConfig } from '@qbit/wallet-shared'

import type { BaseHttpClient } from '../client/http-client'
import { getLocalVersionNotice } from '../config/local-version-notices'
import { getLocalWalletConfig } from '../config/local-wallet-config'
import type { VersionDetail } from '../types'

export class ConfigService {
  constructor(private readonly httpClient: BaseHttpClient) {}

  /**
   * Get the configuration bundled with this wallet release.
   */
  async getWalletConfig(): Promise<WalletConfig> {
    return getLocalWalletConfig()
  }

  /**
   * Get block activity information
   */
  async getBlockActiveInfo(): Promise<{
    allTransactions: number
    allAddrs: number
    currentHeight: number
    recentBlocks: Array<{
      height: number
      timestamp: number
      txCount: number
    }>
  }> {
    return this.httpClient.get('/v5/default/block-active-info')
  }

  /** Return the "what's new" notice bundled with this wallet release. */
  async getVersionDetail(version: string): Promise<VersionDetail> {
    return getLocalVersionNotice(version)
  }

}
