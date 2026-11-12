import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BUS_METHODS } from '@qbit/wallet-shared'

import { globalActions } from '../../src/reducers/global'
import { AccountUpdater } from '../../src/updater/accounts'
import { uiEventBus } from '../../src/utils/eventBus'
import { createHookTestHarness, createWalletMock } from '../ui-hooks/testHelpers'

type LockState = { isBooted: boolean; isUnlocked: boolean }

// Layout sends a page to the unlock screen while its store knows of a vault
// (isBooted) and says the wallet is locked.
const sendsToUnlock = (state: LockState) => state.isBooted && !state.isUnlocked

/** A vault read the test answers when it chooses. */
function pendingRead() {
  let answer!: (hasVault: boolean) => void
  const promise = new Promise<boolean>(resolve => {
    answer = resolve
  })
  return { promise, answer }
}

/**
 * A page with the updater mounted, as it is once the wallet's password exists:
 * unlocked, and, unless `knowsVault`, loaded before the wallet existed. Each
 * vault read is kept for the test to answer, unless `hasVault` reads instead.
 */
function renderPage({
  knowsVault = false,
  hasVault,
}: { knowsVault?: boolean; hasVault?: () => Promise<boolean> } = {}) {
  const reads: ReturnType<typeof pendingRead>[] = []
  const wallet = {
    ...createWalletMock(),
    // A plain function, not a vi.fn: a spy marks each promise it returns as
    // handled, which would hide a rejection the updater leaves unhandled.
    hasVault:
      hasVault ??
      (() => {
        const read = pendingRead()
        reads.push(read)
        return read.promise
      }),
    // The account reload and balance fetch the updater starts stay in flight.
    getKeyrings: () => new Promise<never>(() => undefined),
    getAddressSummary: () => new Promise<never>(() => undefined),
  }
  const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
  store.dispatch(globalActions.update({ isUnlocked: true, isBooted: knowsVault }))
  // Every state the page goes through from here on.
  const states: LockState[] = []
  store.subscribe(() => {
    const { isBooted, isUnlocked } = store.getState().global
    states.push({ isBooted, isUnlocked })
  })
  const view = renderHook(() => AccountUpdater(), { wrapper })
  const lockState = (): LockState => {
    const { isBooted, isUnlocked } = store.getState().global
    return { isBooted, isUnlocked }
  }
  return { store, reads, states, view, lockState }
}

// The background announces a lock or an unlock to every page.
const lock = () =>
  act(() => {
    uiEventBus.emit(BUS_METHODS.LOCKED)
  })
const unlock = () =>
  act(() => {
    uiEventBus.emit(BUS_METHODS.UNLOCKED)
  })
// Lets answered reads publish, and a rejection nobody handled be reported.
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  })

describe('AccountUpdater on a lock', () => {
  it('marks the vault once the background has one, though the page loaded before it existed', async () => {
    // The page the first wallet was created in, or one left on the welcome
    // screen while another page created it.
    const { reads, lockState } = renderPage()

    lock()
    expect(lockState()).toEqual({ isBooted: false, isUnlocked: false })
    // One read per lock.
    expect(reads).toHaveLength(1)
    reads[0]!.answer(true)
    await settle()

    expect(lockState()).toEqual({ isBooted: true, isUnlocked: false })
    expect(sendsToUnlock(lockState())).toBe(true)
  })

  it('keeps a page without a vault where it is', async () => {
    const { reads, states, lockState } = renderPage()

    lock()
    expect(reads).toHaveLength(1)
    reads[0]!.answer(false)
    await settle()

    expect(lockState()).toEqual({ isBooted: false, isUnlocked: false })
    expect(states.some(sendsToUnlock)).toBe(false)
  })

  it('sends a page that loaded with a vault on at the lock, without waiting for the read', async () => {
    const { reads, lockState } = renderPage({ knowsVault: true })

    lock()

    // The read has not answered yet.
    expect(reads).toHaveLength(1)
    expect(lockState()).toEqual({ isBooted: true, isUnlocked: false })
    reads[0]!.answer(true)
    await settle()
    expect(lockState()).toEqual({ isBooted: true, isUnlocked: false })
  })

  it('does not send the page away when an unlock comes before the read answers', async () => {
    const { reads, states, lockState } = renderPage()

    lock()
    unlock()
    expect(reads).toHaveLength(1)
    reads[0]!.answer(true)
    await settle()

    expect(lockState()).toEqual({ isBooted: true, isUnlocked: true })
    expect(states.some(sendsToUnlock)).toBe(false)
  })

  it.each([
    ['rejects', () => Promise.reject(new Error('the port closed'))],
    [
      'throws',
      () => {
        throw new Error('too many requests in flight')
      },
    ],
  ])(
    'changes nothing and leaves nothing unhandled when the read %s, and reads again at the next lock',
    async (_name, failingRead) => {
      const unhandled: unknown[] = []
      const noteUnhandled = (reason: unknown) => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', noteUnhandled)
      try {
        let reads = 0
        const { states, lockState } = renderPage({
          hasVault: () => {
            reads += 1
            return reads === 1 ? failingRead() : Promise.resolve(true)
          },
        })

        lock()
        await settle()

        expect(unhandled).toEqual([])
        expect(lockState()).toEqual({ isBooted: false, isUnlocked: false })
        expect(states.some(sendsToUnlock)).toBe(false)

        unlock()
        lock()
        await settle()

        expect(reads).toBe(2)
        expect(lockState()).toEqual({ isBooted: true, isUnlocked: false })
      } finally {
        process.off('unhandledRejection', noteUnhandled)
      }
    }
  )

  it('lets no late answer undo a newer one: a read from before the vault was saved answers last', async () => {
    const { reads, lockState } = renderPage()

    lock() // asked before the vault was saved
    unlock()
    lock() // asked after
    expect(reads).toHaveLength(2)

    reads[1]!.answer(true)
    await settle()
    expect(lockState()).toEqual({ isBooted: true, isUnlocked: false })

    reads[0]!.answer(false)
    await settle()
    expect(lockState()).toEqual({ isBooted: true, isUnlocked: false })
  })

  it.each([
    ['the newer answer first', [1, 0]],
    ['the older answer first', [0, 1]],
  ] as const)(
    'sends nowhere a page unlocked again before late answers arrive, %s',
    async (_order, order) => {
      const { reads, states, lockState } = renderPage()

      lock()
      unlock()
      lock()
      unlock()
      expect(reads).toHaveLength(2)
      for (const index of order) {
        reads[index]!.answer(true)
        await settle()
        expect(lockState()).toEqual({ isBooted: true, isUnlocked: true })
      }
      expect(states.some(sendsToUnlock)).toBe(false)

      // The page knows of the vault now: the next lock sends it on at once.
      lock()
      expect(sendsToUnlock(lockState())).toBe(true)
    }
  )

  it('neither listens nor publishes once unmounted', async () => {
    const { store, reads, view, lockState } = renderPage()

    lock()
    expect(reads).toHaveLength(1)
    view.unmount()
    reads[0]!.answer(true)
    await settle()
    expect(lockState()).toEqual({ isBooted: false, isUnlocked: false })

    store.dispatch(globalActions.update({ isUnlocked: true }))
    lock()
    await settle()

    expect(reads).toHaveLength(1)
    expect(lockState()).toEqual({ isBooted: false, isUnlocked: true })
  })
})
