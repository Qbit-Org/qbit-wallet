import { describe, expect, it, vi } from 'vitest'

import { AddressType } from '@qbit/wallet-types'
import { BrowserPassworderEncryptor } from '../src/encryptor/browser-encryptor'
import { KeyringService } from '../src/keyring-service'

const mnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const password = 'vault-password-that-must-never-be-persisted-or-logged'

class RecordingStorage {
  readonly values = new Map<string, unknown>()
  readonly writes: Array<{ key: string; value: unknown }> = []

  async get(key: string): Promise<unknown> {
    return this.values.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    const snapshot = structuredClone(value)
    this.values.set(key, snapshot)
    this.writes.push({ key, value: snapshot })
  }
}

describe('vault secret persistence boundary', () => {
  it('never sends a plaintext password or mnemonic to storage or logs', async () => {
    const storage = new RecordingStorage()
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const service = new KeyringService()
    await service.init({
      storage: storage as any,
      encryptor: new BrowserPassworderEncryptor(),
      logger,
      t: (key: string) => key,
    })

    await service.boot(password)
    await service.createKeyringWithMnemonics(
      mnemonic,
      "m/84'/0'/0'/0",
      '',
      AddressType.P2WPKH,
      1
    )
    await service.setLocked()
    await service.submitPassword(password)

    const persisted = JSON.stringify(storage.writes)
    expect(persisted).not.toContain(password)
    expect(persisted).not.toContain(mnemonic)
    expect(persisted).not.toContain(mnemonic.split(' ')[0])

    const state = storage.values.get('keyringState') as { vault?: string }
    expect(state.vault).toEqual(expect.any(String))
    expect(JSON.parse(state.vault!)).toMatchObject({
      data: expect.any(String),
      iv: expect.any(String),
      salt: expect.any(String),
      keyMetadata: {
        algorithm: 'PBKDF2',
        params: { iterations: 900_000 },
      },
    })

    const logged = JSON.stringify(
      Object.values(logger).flatMap(mock => mock.mock.calls)
    )
    expect(logged).not.toContain(password)
    expect(logged).not.toContain(mnemonic)
  })
})
