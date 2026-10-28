import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyPassword = vi.fn()
const setPasswordLifecycleHook = vi.fn()

vi.mock('../src/services/keyring', () => ({
  default: {
    verifyPassword: (...args: unknown[]) => verifyPassword(...args),
    setPasswordLifecycleHook: (...args: unknown[]) => setPasswordLifecycleHook(...args),
  },
}))

import { BiometricUnlockService } from '../src/services/biometricUnlock'

class MemoryStorage {
  readonly values = new Map<string, any>()

  async get(key: string): Promise<any> {
    return this.values.get(key)
  }

  async set(key: string, value: any): Promise<void> {
    this.values.set(key, value)
  }
}

const validRecord = {
  version: 1 as const,
  credentialId: 'Y3JlZC1pZA',
  prfSalt: 'c2FsdA',
  wrappedPassword: 'd3JhcHBlZA',
  iv: 'aXYtaXYtaXY',
  createdAt: 1724800000000,
}

async function createService() {
  const storage = new MemoryStorage()
  const service = new BiometricUnlockService()
  await service.init({ storage, logger: { error() {} } })
  return { service, storage }
}

beforeEach(() => {
  verifyPassword.mockReset()
  setPasswordLifecycleHook.mockReset()
})

describe('BiometricUnlockService', () => {
  it('registers the keyring password lifecycle hook that clears the record', async () => {
    const { service, storage } = await createService()
    expect(setPasswordLifecycleHook).toHaveBeenCalledTimes(1)

    verifyPassword.mockResolvedValue(true)
    await service.saveRecord(validRecord, 'pw')
    expect(storage.values.get('biometricUnlock')).toEqual(validRecord)

    const hook = setPasswordLifecycleHook.mock.calls[0]![0] as () => Promise<void>
    await hook()
    expect(storage.values.get('biometricUnlock')).toBeNull()
    expect((await service.getStatus()).enrolled).toBe(false)
  })

  it('rejects enrollment without a valid wallet password', async () => {
    const { service, storage } = await createService()
    verifyPassword.mockResolvedValue(false)
    await expect(service.saveRecord(validRecord, 'wrong')).rejects.toThrow(
      'valid wallet password'
    )
    expect(storage.values.get('biometricUnlock')).toBeUndefined()
  })

  it('rejects malformed records on save and treats them as absent on read', async () => {
    const { service, storage } = await createService()
    verifyPassword.mockResolvedValue(true)

    await expect(
      service.saveRecord({ ...validRecord, wrappedPassword: '' }, 'pw')
    ).rejects.toThrow('malformed')
    await expect(
      service.saveRecord({ ...validRecord, version: 2 as any }, 'pw')
    ).rejects.toThrow('malformed')

    storage.values.set('biometricUnlock', { garbage: true })
    expect((await service.getStatus()).enrolled).toBe(false)
    expect(await service.getRecord()).toBeNull()
  })

  it('discards a record whose password was changed between verify and write', async () => {
    const { service, storage } = await createService()
    // First verify (pre-ceremony) passes; by the post-write re-verify the
    // password has been changed by a concurrent changePassword().
    verifyPassword.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(service.saveRecord(validRecord, 'old-pw')).rejects.toThrow(
      'changed during biometric enrollment'
    )
    expect(storage.values.get('biometricUnlock')).toBeNull()
    expect((await service.getStatus()).enrolled).toBe(false)
  })

  it('round-trips status and record through clear', async () => {
    const { service } = await createService()
    verifyPassword.mockResolvedValue(true)

    expect((await service.getStatus()).enrolled).toBe(false)
    await service.saveRecord(validRecord, 'pw')
    expect((await service.getStatus()).enrolled).toBe(true)
    expect(await service.getRecord()).toEqual(validRecord)

    await service.clearRecord()
    expect((await service.getStatus()).enrolled).toBe(false)
    expect(await service.getRecord()).toBeNull()
  })
})
