import { ProxyStorageAdapter } from '@qbit/wallet-storage'
import { QbitApiClient } from './api-client'
import { BaseHttpClient } from './client/http-client'

// Service configuration
export interface WalletServiceConfig {
  storage?: ProxyStorageAdapter
  logger?: any
  endpoint?: string
  httpClient?: BaseHttpClient
}

export class WalletApiService {
  private storage: ProxyStorageAdapter = undefined as any
  private client: QbitApiClient = undefined as any
  private currentEndpoint = ''
  private storageKey: string = 'openapi'

  init = async (config: WalletServiceConfig) => {
    if (config.httpClient) {
      this.client = new QbitApiClient(config.httpClient)
    }

    if (config.storage) {
      this.storage = config.storage
    }

    if (config.endpoint) {
      this.currentEndpoint = config.endpoint
    }

    if (!this.storage) {
      throw new Error('WalletApiService: Storage adapter is required')
    }

    if (!this.currentEndpoint) {
      throw new Error('WalletApiService: Endpoint is required')
    }

    await this.storage.set(this.storageKey, null)

    // Update client configuration
    this.client.setBaseURL(this.currentEndpoint)
  }

  resetAllData = async () => {
    await this.storage.set(this.storageKey, null)
  }

  setEndpoint = async (endpoint: string) => {
    this.currentEndpoint = endpoint
    this.client.setBaseURL(this.currentEndpoint)
  }

  // Expose the client for direct access to all API methods
  getClient = (): QbitApiClient => {
    return this.client
  }

  // Proxy common methods for convenience
  get utility() {
    return this.client.utility
  }
  get config() {
    return this.client.config
  }

  get notification() {
    return this.client.notification
  }
}
