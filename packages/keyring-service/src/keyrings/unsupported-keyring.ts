import { Keyring } from '../types'

/**
 * Stands in for a vault entry whose keyring type this build does not ship.
 * It keeps the entry's type and serialized data, so the next vault write
 * carries them unchanged, and it has no accounts, so the wallet lists it as
 * "Unsupported Wallet" and nothing can select it, derive from it or sign with it.
 */
export class UnsupportedKeyring implements Keyring {
  readonly type: string
  private readonly data: unknown

  constructor(type: string, data: unknown) {
    this.type = type
    this.data = data
  }

  async serialize(): Promise<unknown> {
    return structuredClone(this.data)
  }

  async deserialize(): Promise<void> {
    throw this.unsupported()
  }

  async addAccounts(): Promise<string[]> {
    throw this.unsupported()
  }

  async getAccounts(): Promise<string[]> {
    return []
  }

  async signTransaction(): Promise<never> {
    throw this.unsupported()
  }

  async signMessage(): Promise<never> {
    throw this.unsupported()
  }

  async verifyMessage(): Promise<never> {
    throw this.unsupported()
  }

  async exportAccount(): Promise<never> {
    throw this.unsupported()
  }

  removeAccount(): void {
    throw this.unsupported()
  }

  private unsupported(): Error {
    return new Error(`Unsupported keyring type: ${this.type}`)
  }
}
