import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { BUS_METHODS } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'

import { useCreateAccountCallback, useRestoreQbitWalletCallback } from '../src/hooks/global'
import { globalActions } from '../src/reducers'
import { AccountUpdater } from '../src/updater/accounts'
import { uiEventBus } from '../src/utils/eventBus'
import { createHookTestHarness, createWalletMock } from './ui-hooks/testHelpers'

describe('global callbacks', () => {
  it('sends concrete options when qbit restore options are omitted', async () => {
    const report = { floorsCompleted: true }
    const restoreQbitKeyringWithFloors = vi.fn().mockResolvedValue(report)
    const wallet = {
      ...createWalletMock(),
      restoreQbitKeyringWithFloors,
      isUnlocked: vi.fn().mockResolvedValue(true),
    }
    const { wrapper } = createHookTestHarness({ wallet })
    const { result } = renderHook(() => useRestoreQbitWalletCallback(), { wrapper })

    await act(async () => {
      await result.current(
        'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango',
        "m/87'/0'/0'/0",
        '',
        AddressType.P2MR
      )
    })

    expect(restoreQbitKeyringWithFloors).toHaveBeenCalledWith(
      'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango',
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR,
      {}
    )
  })

  const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

  /** A create or restore whose background call returns after the wallet locked. */
  function flowEndingLocked(stillUnlocked: boolean) {
    const wallet = {
      ...createWalletMock(),
      createKeyringWithMnemonics: vi.fn().mockResolvedValue(undefined),
      restoreQbitKeyringWithFloors: vi.fn().mockResolvedValue({ floorsCompleted: true }),
      isUnlocked: vi.fn().mockResolvedValue(stillUnlocked),
    }
    const harness = createHookTestHarness({ wallet })
    // The LOCKED broadcast that arrived mid-flow already set the store.
    harness.store.dispatch(globalActions.update({ isUnlocked: false }))
    return { ...harness, wallet }
  }

  const flows = [
    [
      'creating',
      () => useCreateAccountCallback(),
      (run: any) => run(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR, 1),
    ],
    [
      'restoring',
      () => useRestoreQbitWalletCallback(),
      (run: any) => run(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR),
    ],
  ] as const

  it.each(flows)('keeps the wallet shown as locked when it locked while %s it', async (_name, hook, call) => {
    const { wrapper, store, wallet } = flowEndingLocked(false)
    const { result } = renderHook(hook, { wrapper })

    await act(async () => {
      await call(result.current)
    })

    expect(wallet.isUnlocked).toHaveBeenCalled()
    expect(store.getState().global.isUnlocked).toBe(false)
  })

  it.each(flows)('shows the wallet unlocked after %s it when the background still is', async (_name, hook, call) => {
    const { wrapper, store } = flowEndingLocked(true)
    const { result } = renderHook(hook, { wrapper })

    await act(async () => {
      await call(result.current)
    })

    expect(store.getState().global.isUnlocked).toBe(true)
  })
})

describe('the vault after a create or restore', () => {
  const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'

  type LockState = { isBooted: boolean; isUnlocked: boolean }

  // Layout sends a page to the unlock screen while its store knows of a vault
  // (isBooted) and says the wallet is locked.
  const sendsToUnlock = (state: LockState) => state.isBooted && !state.isUnlocked

  type Flow = readonly [
    name: string,
    method: 'createKeyringWithMnemonics' | 'restoreQbitKeyringWithFloors',
    hook: () => (...args: any[]) => Promise<unknown>,
    call: (run: any) => Promise<unknown>,
  ]

  const flows: Flow[] = [
    [
      'creating',
      'createKeyringWithMnemonics',
      () => useCreateAccountCallback(),
      (run: any) => run(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR, 1),
    ],
    [
      'restoring',
      'restoreQbitKeyringWithFloors',
      () => useRestoreQbitWalletCallback(),
      (run: any) => run(MNEMONIC, "m/87'/0'/0'/0", '', AddressType.P2MR),
    ],
  ]

  /**
   * A page that loaded before the wallet existed, and the background behind
   * it: `save` stands in for the create or restore call, the other reads
   * answer from `background`. The page was told it is unlocked (boot
   * announces it to the page that set the password) only if `toldUnlocked`.
   */
  function setup(
    method: Flow[1],
    save: () => Promise<unknown>,
    background: { unlocked: boolean; vault: boolean },
    {
      toldUnlocked = true,
      isUnlocked = () => Promise.resolve(background.unlocked),
      hasVault = () => Promise.resolve(background.vault),
    }: {
      toldUnlocked?: boolean
      isUnlocked?: () => Promise<boolean>
      hasVault?: () => Promise<boolean>
    } = {}
  ) {
    // How many times each read was made. A failed call passes its error on
    // without waiting for the reads after it, so a test waits for them before
    // it checks what they did.
    const reads = { isUnlocked: 0, hasVault: 0 }
    // Plain functions, not vi.fn spies: a spy marks each promise it returns as
    // handled, which would hide a rejection left unhandled.
    const wallet = {
      ...createWalletMock(),
      [method]: save,
      isUnlocked: () => {
        reads.isUnlocked += 1
        return isUnlocked()
      },
      hasVault: () => {
        reads.hasVault += 1
        return hasVault()
      },
      // The account reload and balance fetch the updater starts stay in flight.
      getKeyrings: () => new Promise<never>(() => undefined),
      getAddressSummary: () => new Promise<never>(() => undefined),
    }
    const harness = createHookTestHarness({ wallet: wallet as any })
    harness.store.dispatch(globalActions.update({ isUnlocked: toldUnlocked, isBooted: false }))
    // Every state the page goes through from here on.
    const states: LockState[] = []
    harness.store.subscribe(() => {
      const { isBooted, isUnlocked } = harness.store.getState().global
      states.push({ isBooted, isUnlocked })
    })
    const lockState = (): LockState => {
      const { isBooted, isUnlocked } = harness.store.getState().global
      return { isBooted, isUnlocked }
    }
    return { ...harness, states, lockState, reads }
  }

  /** A create or restore call that returns or fails when the test says. */
  function pendingSave() {
    let finish!: () => void
    let fail!: (error: Error) => void
    const promise = new Promise<unknown>((resolve, reject) => {
      finish = () => resolve({ floorsCompleted: true })
      fail = reject
    })
    return { save: () => promise, finish, fail }
  }

  // Starts the call; the promise settles to 'returned' or to the error.
  function start(run: () => Promise<unknown>) {
    let outcome!: Promise<unknown>
    act(() => {
      outcome = run().then(
        () => 'returned',
        (error: unknown) => error
      )
    })
    return outcome
  }

  // Lets answered reads publish, and a rejection nobody handled be reported.
  const settle = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

  it.each(flows)(
    'sends the page to the unlock screen once %s the first wallet returns, after a lock that found no vault yet',
    async (_name, method, hook, call) => {
      const background = { unlocked: true, vault: false }
      const pending = pendingSave()
      const { wrapper, lockState } = setup(method, pending.save, background)
      const { result } = renderHook(
        () => {
          AccountUpdater()
          return hook()
        },
        { wrapper }
      )
      const outcome = start(() => call(result.current))

      // The lock lands while the vault is being saved: the read at the lock
      // finds none.
      background.unlocked = false
      act(() => {
        uiEventBus.emit(BUS_METHODS.LOCKED)
      })
      await settle()
      expect(lockState()).toEqual({ isBooted: false, isUnlocked: false })

      // The vault is saved after all, and the call returns.
      background.vault = true
      let settled: unknown
      await act(async () => {
        pending.finish()
        settled = await outcome
      })
      expect(settled).toBe('returned')

      expect(lockState()).toEqual({ isBooted: true, isUnlocked: false })
      expect(sendsToUnlock(lockState())).toBe(true)
    }
  )

  it.each(flows)(
    'sends the page to the unlock screen when %s the first wallet fails after a lock, once the vault was saved',
    async (_name, method, hook, call) => {
      const background = { unlocked: true, vault: false }
      const pending = pendingSave()
      const { wrapper, lockState } = setup(method, pending.save, background)
      const { result } = renderHook(
        () => {
          AccountUpdater()
          return hook()
        },
        { wrapper }
      )
      const outcome = start(() => call(result.current))

      background.unlocked = false
      act(() => {
        uiEventBus.emit(BUS_METHODS.LOCKED)
      })
      await settle()
      expect(lockState()).toEqual({ isBooted: false, isUnlocked: false })

      // The wallet was saved, then a later step failed because of the lock.
      background.vault = true
      const failure = new Error('no keyring found for the requested account')
      let settled: unknown
      await act(async () => {
        pending.fail(failure)
        settled = await outcome
      })
      expect(settled).toBe(failure)

      // The vault is marked after the error was passed on.
      await waitFor(() => expect(lockState()).toEqual({ isBooted: true, isUnlocked: false }))
    }
  )

  it.each(flows)(
    'marks the unlock and the vault in one update after %s it, for a page never told it was unlocked',
    async (_name, method, hook, call) => {
      const background = { unlocked: true, vault: true }
      const { wrapper, states, lockState } = setup(
        method,
        async () => ({ floorsCompleted: true }),
        background,
        {
          toldUnlocked: false,
        }
      )
      const { result } = renderHook(hook, { wrapper })

      expect(await start(() => call(result.current))).toBe('returned')

      expect(lockState()).toEqual({ isBooted: true, isUnlocked: true })
      expect(states.some(sendsToUnlock)).toBe(false)
    }
  )

  it.each(flows)(
    'keeps the page where it is when %s it fails before a vault was saved',
    async (_name, method, hook, call) => {
      // A lock before the save fails the call, and no vault is written.
      const background = { unlocked: false, vault: false }
      const failure = new Error('KeyringController - password is not a string')
      const { wrapper, states, lockState, reads } = setup(
        method,
        () => Promise.reject(failure),
        background
      )
      const { result } = renderHook(hook, { wrapper })

      expect(await start(() => call(result.current))).toBe(failure)
      // The reads after the failure have answered: locked, and no vault.
      await waitFor(() => expect(reads.hasVault).toBe(1))
      await settle()

      expect(lockState().isBooted).toBe(false)
      expect(states.some(sendsToUnlock)).toBe(false)
    }
  )

  it.each(flows)(
    'does not send away a page never told it was unlocked when %s it fails while unlocked',
    async (_name, method, hook, call) => {
      const background = { unlocked: true, vault: true }
      const failure = new Error('wallet_existed')
      const { wrapper, states, lockState, reads } = setup(
        method,
        () => Promise.reject(failure),
        background,
        {
          toldUnlocked: false,
        }
      )
      const { result } = renderHook(hook, { wrapper })

      expect(await start(() => call(result.current))).toBe(failure)
      // The read after the failure has answered: unlocked.
      await waitFor(() => expect(reads.isUnlocked).toBe(1))
      await settle()

      expect(lockState()).toEqual({ isBooted: false, isUnlocked: false })
      expect(states.some(sendsToUnlock)).toBe(false)
    }
  )

  type FailedRead = readonly [
    name: string,
    read: string,
    method: Flow[1],
    hook: Flow[2],
    call: Flow[3],
    isUnlocked: () => Promise<boolean>,
    hasVault: (() => Promise<boolean>) | undefined,
  ]

  const failedReads = flows.flatMap(([name, method, hook, call]): FailedRead[] => [
    [
      name,
      'reading the lock state',
      method,
      hook,
      call,
      () => Promise.reject(new Error('the port closed')),
      undefined,
    ],
    [
      name,
      'reading the vault',
      method,
      hook,
      call,
      () => Promise.resolve(false),
      () => Promise.reject(new Error('the port closed')),
    ],
  ])

  it.each(failedReads)(
    '%s a wallet that fails keeps its error when %s fails too, and leaves nothing unhandled',
    async (_name, _read, method, hook, call, isUnlocked, hasVault) => {
      const unhandled: unknown[] = []
      const noteUnhandled = (reason: unknown) => {
        unhandled.push(reason)
      }
      process.on('unhandledRejection', noteUnhandled)
      try {
        const background = { unlocked: false, vault: true }
        const failure = new Error('the explorer is down')
        const { wrapper, states, reads } = setup(
          method,
          () => Promise.reject(failure),
          background,
          {
            isUnlocked,
            ...(hasVault ? { hasVault } : {}),
          }
        )
        const { result } = renderHook(hook, { wrapper })

        expect(await start(() => call(result.current))).toBe(failure)
        // The read that fails has been made after the failure.
        await waitFor(() => expect(hasVault ? reads.hasVault : reads.isUnlocked).toBe(1))
        await settle()

        expect(unhandled).toEqual([])
        expect(states).toEqual([])
      } finally {
        process.off('unhandledRejection', noteUnhandled)
      }
    }
  )

  type UnansweredRead = readonly [
    name: string,
    read: string,
    method: Flow[1],
    hook: Flow[2],
    call: Flow[3],
    reads: { isUnlocked: () => Promise<boolean>; hasVault?: () => Promise<boolean> },
  ]

  const neverAnswers = () => new Promise<boolean>(() => undefined)

  const unansweredReads = flows.flatMap(([name, method, hook, call]): UnansweredRead[] => [
    [name, 'whether it is locked', method, hook, call, { isUnlocked: neverAnswers }],
    [
      name,
      'the vault',
      method,
      hook,
      call,
      { isUnlocked: () => Promise.resolve(false), hasVault: neverAnswers },
    ],
  ])

  it.each(unansweredReads)(
    '%s a wallet that fails passes its error on at once when reading %s after it never answers',
    async (_name, _read, method, hook, call, reads) => {
      // A background that is restarting or stuck answers nothing.
      const failure = new Error('the explorer is down')
      const { wrapper } = setup(
        method,
        () => Promise.reject(failure),
        { unlocked: false, vault: true },
        reads
      )
      const { result } = renderHook(hook, { wrapper })

      const outcome = start(() => call(result.current))
      const first = await Promise.race([
        outcome,
        new Promise(resolve => setTimeout(() => resolve('still waiting'), 50)),
      ])

      expect(first).toBe(failure)
    }
  )

  it.each(flows)(
    'marks the vault after %s a wallet fails while locked, though its screen has gone',
    async (_name, method, hook, call) => {
      const failure = new Error('no keyring found for the requested account')
      let answerLockRead!: (unlocked: boolean) => void
      // The LOCKED broadcast already marked the page locked.
      const { wrapper, lockState } = setup(
        method,
        () => Promise.reject(failure),
        { unlocked: false, vault: true },
        {
          toldUnlocked: false,
          isUnlocked: () =>
            new Promise<boolean>(resolve => {
              answerLockRead = resolve
            }),
        }
      )
      const view = renderHook(hook, { wrapper })

      expect(await start(() => call(view.result.current))).toBe(failure)
      // The screen goes before the reads after the failure answer. The store
      // outlives it, and the vault is still there, so it is marked.
      view.unmount()
      answerLockRead(false)

      await waitFor(() => expect(lockState()).toEqual({ isBooted: true, isUnlocked: false }))
    }
  )
})
