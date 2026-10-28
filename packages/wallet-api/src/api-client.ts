/** Qbit Wallet API client. */

// Export client
export { HttpClient } from './client/http-client'

// Export all services
export * from './services'

// Export all types
export * from './types'

// Export main client class
import { BaseHttpClient } from './client/http-client'
import { ConfigService, NotificationService, UtilityService } from './services'

export class QbitApiClient {
  public readonly utility: UtilityService
  public readonly config: ConfigService
  public readonly notification: NotificationService

  private readonly httpClient: BaseHttpClient

  constructor(httpClient: BaseHttpClient) {
    this.httpClient = httpClient

    this.utility = new UtilityService(this.httpClient)
    this.config = new ConfigService(this.httpClient)
    this.notification = new NotificationService(this.httpClient)
  }

  // ========================================
  // HTTP Client configuration methods
  // ========================================

  /**
   * Set base URL
   */
  setBaseURL(baseURL: string): void {
    this.httpClient.setBaseURL(baseURL)
  }

  /**
   * Set request headers
   */
  setHeaders(headers: Record<string, string>): void {
    this.httpClient.setHeaders(headers)
  }

  /**
   * Get underlying HTTP client
   */
  getHttpClient(): BaseHttpClient {
    return this.httpClient
  }
}
