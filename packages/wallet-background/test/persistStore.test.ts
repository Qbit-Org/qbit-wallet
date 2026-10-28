import { beforeEach, describe, expect, it, vi } from 'vitest'

import createPersistStore, { initPersistStoreStorage } from '../src/utils/persistStore'

describe('createPersistStore', () => {
  const get = vi.fn()
  const set = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    initPersistStoreStorage({ get, set })
  })

  it('loads cache from storage when available', async () => {
    get.mockResolvedValue({ foo: 1 })

    const store = await createPersistStore<{ foo: number }>({
      name: 'wallet',
      template: { foo: 0 },
    })

    expect(get).toHaveBeenCalledWith('wallet')
    expect(set).not.toHaveBeenCalled()
    expect(store.foo).toBe(1)
  })

  it('initializes storage with template when cache is empty', async () => {
    get.mockResolvedValue(undefined)

    const store = await createPersistStore<{ foo: number }>({
      name: 'wallet',
      template: { foo: 2 },
    })

    expect(set).toHaveBeenCalledWith('wallet', { foo: 2 })
    expect(store.foo).toBe(2)
  })

  it('persists updates and deletes via proxied object (debounced)', async () => {
    get.mockResolvedValue({ foo: 1, bar: 'x' })
    const store = await createPersistStore<{ foo: number; bar?: string }>({
      name: 'wallet',
      template: { foo: 0 },
    })

    set.mockClear()

    store.foo = 9
    delete store.bar

    expect(set).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    await Promise.resolve()

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenLastCalledWith('wallet', { foo: 9 })
  })

  it('skips storage read when fromStorage=false', async () => {
    get.mockResolvedValue({ foo: 10 })

    const store = await createPersistStore<{ foo: number }>({
      name: 'wallet',
      template: { foo: 3 },
      fromStorage: false,
    })

    expect(get).not.toHaveBeenCalled()
    expect(store.foo).toBe(3)
  })
})
