import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('falls back to template when get throws and persists initial value', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    adapter.get.mockRejectedValue(new Error('read failed'))
    adapter.set.mockResolvedValue(undefined)

    const proxy = await adapter.createPersistentProxy('prefs', { x: 1 })

    expect(warnSpy).toHaveBeenCalled()
    expect(adapter.set).toHaveBeenCalledWith('prefs', { x: 1 })
    expect(proxy.x).toBe(1)
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

  it('swallows debounced save errors but still attempts persistence', async () => {
    adapter.get.mockResolvedValue({ n: 1 })
    adapter.set.mockResolvedValue(undefined)

    const proxy = await adapter.createPersistentProxy<{ n: number }>('prefs', { n: 0 })

    adapter.set.mockClear()
    adapter.set.mockRejectedValueOnce(new Error('write failed'))

    proxy.n = 2

    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(adapter.set).toHaveBeenCalledWith('prefs', { n: 2 })
  })
})
