import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BaseProxyStorageAdapter } from '../src/base-storage'

class TestAdapter extends BaseProxyStorageAdapter {
  get = vi.fn<Parameters<BaseProxyStorageAdapter['get']>, ReturnType<BaseProxyStorageAdapter['get']>>()
  set = vi.fn<Parameters<BaseProxyStorageAdapter['set']>, ReturnType<BaseProxyStorageAdapter['set']>>()
}

describe('BaseProxyStorageAdapter.createPersistentProxy', () => {
  let adapter: TestAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    adapter = new TestAdapter()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('merges stored data into template when storage already has value', async () => {
    adapter.get.mockResolvedValue({ theme: 'dark' })

    const proxy = await adapter.createPersistentProxy('prefs', {
      theme: 'light',
      lang: 'en',
    })

    expect(adapter.get).toHaveBeenCalledWith('prefs')
    expect(adapter.set).not.toHaveBeenCalled()
    expect(proxy).toEqual({ theme: 'dark', lang: 'en' })
  })

  it('writes template to storage when key does not exist', async () => {
    adapter.get.mockResolvedValue(undefined)
    adapter.set.mockResolvedValue(undefined)

    const proxy = await adapter.createPersistentProxy('prefs', {
      theme: 'light',
      lang: 'en',
    })

    expect(adapter.set).toHaveBeenCalledWith('prefs', { theme: 'light', lang: 'en' })
    expect(proxy.lang).toBe('en')
  })

  it('saves the template when its first write fails once', async () => {
    adapter.get.mockResolvedValue(undefined)
    adapter.set.mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined)

    const result = adapter.createPersistentProxy('prefs', { theme: 'light', lang: 'en' })
    const assertion = expect(result).resolves.toEqual({ theme: 'light', lang: 'en' })
    await vi.runAllTimersAsync()
    await assertion

    expect(adapter.get).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenCalledTimes(2)
    expect(adapter.set).toHaveBeenNthCalledWith(1, 'prefs', { theme: 'light', lang: 'en' })
    expect(adapter.set).toHaveBeenNthCalledWith(2, 'prefs', { theme: 'light', lang: 'en' })

    // The proxy owns the key and saves later changes.
    const proxy = await result
    proxy.theme = 'dark'
    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { theme: 'dark', lang: 'en' })
  })

  it('rejects after three attempts when the template cannot be saved', async () => {
    adapter.get.mockResolvedValue(undefined)
    const writeError = new Error('write failed')
    adapter.set.mockRejectedValue(writeError)

    const result = adapter.createPersistentProxy('prefs', { theme: 'light' })
    const assertion = expect(result).rejects.toBe(writeError)
    await vi.runAllTimersAsync()
    await assertion

    expect(adapter.get).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenCalledTimes(3)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { theme: 'light' })
  })

  it('stops retrying the template once a newer proxy owns the key', async () => {
    adapter.get.mockResolvedValue(undefined)
    const writeError = new Error('write failed')
    adapter.set.mockRejectedValueOnce(writeError).mockResolvedValue(undefined)

    const replaced = adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })
    const assertion = expect(replaced).rejects.toBe(writeError)
    // The first attempt has failed, and the retry is waiting.
    await vi.advanceTimersByTimeAsync(50)
    expect(adapter.set).toHaveBeenCalledTimes(1)
    const current = await adapter.createPersistentProxy<{ n: number }>(
      'prefs',
      { n: 5 },
      { reset: true }
    )
    await vi.runAllTimersAsync()
    await assertion

    expect(adapter.set).toHaveBeenCalledTimes(2)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { n: 5 })
    current.n = 6
    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { n: 6 })
  })

  it('rejects without writing the template when the stored data cannot be read', async () => {
    const readError = new Error('read failed')
    adapter.get.mockRejectedValue(readError)

    const result = adapter.createPersistentProxy('prefs', {
      currentAccount: null,
      chainType: 'QBIT_MAINNET',
    })
    const assertion = expect(result).rejects.toMatchObject({
      message: 'Failed to load stored data for prefs',
      cause: readError,
    })
    await vi.runAllTimersAsync()
    await assertion

    expect(adapter.get).toHaveBeenCalledTimes(3)
    expect(adapter.set).not.toHaveBeenCalled()
  })

  it('keeps the stored data when a read fails once and then succeeds', async () => {
    adapter.get
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ currentAccount: 'X', chainType: 'QBIT_TESTNET4' })

    const result = adapter.createPersistentProxy('prefs', {
      currentAccount: null,
      chainType: 'QBIT_MAINNET',
    })
    await vi.runAllTimersAsync()
    const proxy = await result

    expect(proxy).toEqual({ currentAccount: 'X', chainType: 'QBIT_TESTNET4' })
    expect(adapter.set).not.toHaveBeenCalled()
  })

  it('persists property updates and deletes through debounced save', async () => {
    adapter.get.mockResolvedValue({ a: 1, b: 2 })
    adapter.set.mockResolvedValue(undefined)

    const proxy = await adapter.createPersistentProxy<{ a: number; b?: number }>('prefs', { a: 0 })

    adapter.set.mockClear()

    proxy.a = 9
    delete proxy.b

    expect(adapter.set).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    await Promise.resolve()

    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { a: 9 })
  })

  it('rejects nested writes instead of losing them', async () => {
    adapter.get.mockResolvedValue({ names: { keyring_0: 'Main' }, list: ['a'] })
    adapter.set.mockResolvedValue(undefined)

    const proxy = await adapter.createPersistentProxy<{
      names: Record<string, string>
      list: string[]
    }>('prefs', { names: {}, list: [] })

    expect(() => {
      proxy.names['keyring_7'] = 'Savings'
    }).toThrow(TypeError)
    expect(() => {
      delete proxy.names['keyring_0']
    }).toThrow(TypeError)
    expect(() => proxy.list.push('b')).toThrow(TypeError)

    proxy.names = { ...proxy.names, keyring_7: 'Savings' }
    vi.advanceTimersByTime(1000)

    expect(adapter.set).toHaveBeenLastCalledWith('prefs', {
      names: { keyring_0: 'Main', keyring_7: 'Savings' },
      list: ['a'],
    })
    expect(() => {
      proxy.names['keyring_8'] = 'Other'
    }).toThrow(TypeError)
  })

  it('stores a copy of assigned values and leaves the template and caller objects writable', async () => {
    adapter.get.mockResolvedValue(undefined)
    adapter.set.mockResolvedValue(undefined)
    const template = { account: { name: 'template' } as { name: string } | null }

    const proxy = await adapter.createPersistentProxy('prefs', template)
    const account = { name: 'first' }
    proxy.account = account
    account.name = 'changed by caller'
    template.account!.name = 'template changed'

    expect(proxy.account).toEqual({ name: 'first' })
    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { account: { name: 'first' } })
  })

  it('stops saving a proxy once another proxy replaces it for the same key', async () => {
    adapter.get.mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce(null)
    adapter.set.mockResolvedValue(undefined)

    const replaced = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })
    replaced.n = 2
    const current = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })
    adapter.set.mockClear()

    vi.advanceTimersByTime(1000)
    replaced.n = 3
    vi.advanceTimersByTime(1000)
    expect(adapter.set).not.toHaveBeenCalled()

    current.n = 4
    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { n: 4 })
  })

  it('replaces the stored data on reset without reading it, before the previous proxy saves', async () => {
    adapter.get.mockResolvedValue({ n: 1 })
    adapter.set.mockResolvedValue(undefined)

    const previous = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })
    previous.n = 2
    const current = await adapter.createPersistentProxy<{ n: number }>(
      'prefs',
      { n: 0 },
      { reset: true }
    )

    expect(adapter.get).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { n: 0 })
    expect(current.n).toBe(0)

    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenCalledTimes(1)
  })

  it('hands the key back to the previous proxy when its replacement cannot be saved', async () => {
    adapter.get.mockResolvedValue({ n: 1 })
    adapter.set.mockResolvedValue(undefined)

    const previous = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })
    previous.n = 2
    const writeError = new Error('write failed')
    adapter.set.mockRejectedValue(writeError)

    const reset = adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 }, { reset: true })
    const assertion = expect(reset).rejects.toBe(writeError)
    await vi.advanceTimersByTimeAsync(300)
    await assertion
    expect(adapter.set).toHaveBeenCalledTimes(3)

    adapter.set.mockResolvedValue(undefined)
    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenCalledTimes(4)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { n: 2 })
  })

  it('flushes a proxy with one immediate write and keeps a failed flush queued', async () => {
    adapter.get.mockResolvedValue({ n: 1 })
    adapter.set.mockResolvedValue(undefined)
    const proxy = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })

    proxy.n = 2
    await adapter.flushPersistentProxy(proxy)
    expect(adapter.set).toHaveBeenCalledTimes(1)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { n: 2 })
    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenCalledTimes(1)

    const writeError = new Error('write failed')
    adapter.set.mockRejectedValueOnce(writeError)
    proxy.n = 3
    await expect(adapter.flushPersistentProxy(proxy)).rejects.toBe(writeError)
    vi.advanceTimersByTime(1000)
    expect(adapter.set).toHaveBeenCalledTimes(3)
    expect(adapter.set).toHaveBeenLastCalledWith('prefs', { n: 3 })
  })

  it('refuses to flush a proxy that a newer proxy replaced', async () => {
    adapter.get.mockResolvedValue({ n: 1 })
    adapter.set.mockResolvedValue(undefined)
    const replaced = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })
    await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 }, { reset: true })
    adapter.set.mockClear()

    replaced.n = 2
    await expect(adapter.flushPersistentProxy(replaced)).rejects.toThrow(
      'A newer store replaced prefs; not saved'
    )
    await expect(adapter.flushPersistentProxy({ n: 2 })).rejects.toThrow(
      'Not a persistent proxy of this storage adapter'
    )
    expect(adapter.set).not.toHaveBeenCalled()
  })

  it('reports debounced save errors and still attempts persistence', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    adapter.get.mockResolvedValue({ n: 1 })
    adapter.set.mockResolvedValue(undefined)

    const proxy = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })

    adapter.set.mockClear()
    const writeError = new Error('write failed')
    adapter.set.mockRejectedValueOnce(writeError)

    proxy.n = 2

    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(adapter.set).toHaveBeenCalledWith('prefs', { n: 2 })
    expect(errorSpy).toHaveBeenCalledWith('Failed to save preference data for prefs:', writeError)
  })
})
