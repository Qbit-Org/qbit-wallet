import { Encryptor } from '../types'

import * as browserPassworder from '@metamask/browser-passworder'

// The MetaMask implementation decrypts the earlier 10,000-round format when
// keyMetadata is absent and writes the current 900,000-round format.
export class BrowserPassworderEncryptor implements Encryptor {
  async encrypt(password: string, data: any): Promise<string> {
    return await browserPassworder.encrypt(password, data)
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    return await browserPassworder.decrypt(password, encryptedData)
  }

  isVaultUpdated(encryptedData: string): boolean {
    return browserPassworder.isVaultUpdated(encryptedData)
  }

  async updateVault(encryptedData: string, password: string): Promise<string> {
    return await browserPassworder.updateVault(encryptedData, password)
  }
}
