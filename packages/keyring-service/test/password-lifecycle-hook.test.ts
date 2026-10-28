import { describe, expect, it } from 'vitest'

import { AddressType } from '@qbit/wallet-types'
import { KeyringService, type PasswordLifecycleEvent } from '../src/keyring-service'
import type { Encryptor } from '../src/types'

const password = 'lifecycle-password'
const newPassword = 'lifecycle-new-password'
const sampleMnemonic =
  'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    const value = this.values.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, structuredClone(value))
  }
}

class JsonEncryptor implements Encryptor {
  async encrypt(secret: string, data: any): Promise<string> {
    return JSON.stringify({ password: secret, data })
  }

  async decrypt(secret: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== secret) {
      throw new Error('bad password')
    }
    return parsed.data
  }
}

class RecordingLogger {
  readonly errors: unknown[][] = []
  debug() {}
  info() {}
  warn() {}
  error(...args: unknown[]) {
    this.errors.push(args)
  }
}

async function createService(logger: RecordingLogger = new RecordingLogger()) {
  const service = new KeyringService()
  await service.init({
    storage: new MemoryStorage() as any,
    encryptor: new JsonEncryptor(),
    logger,
    t: (key: string) => key,
  })
  return service
}

async function createBootedWallet(logger?: RecordingLogger) {
  const service = await createService(logger)
  await service.boot(password)
  await service.createKeyringWithMnemonics(
    sampleMnemonic,
    "m/84'/0'/0'/0",
    '',
    AddressType.P2WPKH,
    1
  )
  return service
}

describe('password lifecycle hook', () => {
  it('fires boot while boot() is still pending', async () => {
    const service = await createService()
    const events: PasswordLifecycleEvent[] = []
    service.setPasswordLifecycleHook(async event => {
      events.push(event)
    })

    await service.boot(password)
    expect(events).toEqual(['boot'])
  })

  it('fires passwordChanged before changePassword resolves and before a queued unlock runs', async () => {
    const service = await createBootedWallet()

    let hookResolved = false
    const events: PasswordLifecycleEvent[] = []
    service.setPasswordLifecycleHook(async event => {
      events.push(event)
      // Yield so an improperly ordered implementation could overtake the hook.
      await new Promise(resolve => setTimeout(resolve, 10))
      hookResolved = true
    })

    // A concurrent unlock with the old password queues on unlockingMutex; it
    // must observe the post-change state (and fail) rather than racing the
    // invalidation hook.
    const changePromise = service.changePassword(password, newPassword)
    const staleUnlock = service.submitPassword(password).then(
      () => 'unlocked',
      () => 'rejected'
    )

    await changePromise
    expect(events).toEqual(['passwordChanged'])
    expect(hookResolved).toBe(true)
    expect(await staleUnlock).toBe('rejected')
    expect(await service.verifyPassword(newPassword)).toBe(true)
  })

  it('fires reset on resetAllData', async () => {
    const service = await createBootedWallet()
    const events: PasswordLifecycleEvent[] = []
    service.setPasswordLifecycleHook(async event => {
      events.push(event)
    })

    await service.resetAllData()
    expect(events).toEqual(['reset'])
  })

  it('logs and swallows hook failures without failing the password mutation', async () => {
    const logger = new RecordingLogger()
    const service = await createBootedWallet(logger)
    service.setPasswordLifecycleHook(async () => {
      throw new Error('hook exploded')
    })

    await expect(service.changePassword(password, newPassword)).resolves.toBeUndefined()
    expect(await service.verifyPassword(newPassword)).toBe(true)
    expect(
      logger.errors.some(args =>
        String(args[0]).includes('password lifecycle hook failed')
      )
    ).toBe(true)
  })
})
