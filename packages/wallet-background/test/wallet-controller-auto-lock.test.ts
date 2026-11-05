import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUS_EVENTS, BUS_METHODS, ErrorCodes } from '@qbit/wallet-shared'

import { WalletController } from '../src/controllers/wallet'
import { contactBookService, preferenceService } from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'

// The keyring as the lock and the unlock see it: whether it reads unlocked,
// whether a vault exists, setLocked, and submitPassword, which publishes the
// unlock only if no lock came in while it ran, as the keyring service does.
// The rest of the background is the real one.
const keyring = vi.hoisted(() => {
  const state = { isUnlocked: true, hasVault: true, submitting: false, lockedWhileSubmitting: false }
  // Held open to let a test lock during the unlock's last step.
  let lastStep: Promise<void> = Promise.resolve()
  const service = {
    keyrings: [],
    memStore: { getState: () => ({ isUnlocked: state.isUnlocked }) } as
      | { getState(): { isUnlocked: boolean } }
      | undefined,
    hasVault: () => state.hasVault,
    syncQbitHdPath: async () => false,
    setLocked: async () => {
      state.isUnlocked = false
      if (state.submitting) state.lockedWhileSubmitting = true
      return { isUnlocked: false }
    },
    submitPassword: async (_password: string, options?: { beforeUnlock?: () => Promise<void> }) => {
      state.submitting = true
      state.lockedWhileSubmitting = false
      try {
        await options?.beforeUnlock?.()
        await lastStep
        if (!state.lockedWhileSubmitting) state.isUnlocked = true
      } catch (error) {
        state.isUnlocked = false
        throw error
      } finally {
        state.submitting = false
      }
      return { isUnlocked: state.isUnlocked }
    },
  }
  return {
    state,
    service,
    holdLastStep: (step: Promise<void>) => {
      lastStep = step
    },
  }
})

vi.mock('../src/services', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services')>()),
  keyringService: keyring.service,
}))

// Keeps what was written as JSON, like chrome.storage.local.
class DiskAdapter {
  disk = new Map<string, string>()

  async createPersistentProxy<T extends object>(name: string, template: T): Promise<T> {
    return { ...template, ...(await this.get(name)) }
  }

  async get(key: string): Promise<any> {
    const raw = this.disk.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: any): Promise<void> {
    this.disk.set(key, JSON.stringify(value))
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const SECONDS = 1000
const MINUTES = 60 * SECONDS
// The default auto-lock time, and the 30-second one.
const DEFAULT_LOCK_MS = 3 * MINUTES
const SHORTEST_LOCK_ID = 0
const SHORTEST_LOCK_MS = 30 * SECONDS
// How often useWalletKeepalive refreshes the session.
const KEEPALIVE_INTERVAL_MS = 10 * SECONDS

let adapter: DiskAdapter
let wallet: WalletController
let setLocked: ReturnType<typeof vi.spyOn>
let broadcasts: string[]
const record = ({ method }: { method: string }) => broadcasts.push(method)

/** The computer sleeps: the wall clock moves on, and no timer runs. */
function sleep(ms: number) {
  vi.setSystemTime(Date.now() + ms)
}

beforeEach(async () => {
  vi.useFakeTimers()
  adapter = new DiskAdapter()
  await preferenceService.init({ storage: adapter as any, logger })
  Object.assign(keyring.state, { isUnlocked: true, hasVault: true, submitting: false })
  keyring.holdLastStep(Promise.resolve())
  keyring.service.memStore = { getState: () => ({ isUnlocked: keyring.state.isUnlocked }) }
  setLocked = vi.spyOn(keyring.service, 'setLocked')
  broadcasts = []
  bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, record)
  wallet = new WalletController({ now: () => Date.now() })
  // What unlocking reads besides the keyring, none of it under test here.
  vi.spyOn(wallet, 'getCurrentKeyring').mockResolvedValue(undefined as any)
  vi.spyOn(contactBookService, 'listAlias').mockReturnValue([{} as any])
  ;(wallet as any).kickPendingQbitRestoreFloorScan = () => undefined
})

/** Hold the chain-state queue the way a restore floor scan would, until released. */
function holdChainStateQueue() {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  void (wallet as any).enqueueChainStateChange(() => held)
  return release
}

const LOCKED_DURING_UNLOCK = { code: ErrorCodes.WALLET_LOCKED_DURING_UNLOCK }

afterEach(() => {
  bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, record)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the auto-lock', () => {
  it('locks once the auto-lock time passes without a screen action', async () => {
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
    expect(setLocked).toHaveBeenCalledTimes(1)
    expect(broadcasts.sort()).toEqual([BUS_METHODS.AUTO_LOCKED, BUS_METHODS.LOCKED].sort())
  })

  it('starts the time over on a screen action before the deadline', async () => {
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(2 * MINUTES)
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('locks on the first screen action after the deadline instead of extending the session', async () => {
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(1 * MINUTES)
    // The computer sleeps past the deadline; the timer has not run.
    sleep(10 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)

    // The first click after waking.
    await wallet.setLastActiveTime()
    expect(wallet.isUnlocked()).toBe(false)
    expect(setLocked).toHaveBeenCalledTimes(1)
    expect(broadcasts.sort()).toEqual([BUS_METHODS.AUTO_LOCKED, BUS_METHODS.LOCKED].sort())

    // The timer that slept is gone, so it does not lock a second time.
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    expect(setLocked).toHaveBeenCalledTimes(1)
  })

  it('keeps the session when the action comes just before the deadline', async () => {
    await wallet.setLastActiveTime()
    sleep(DEFAULT_LOCK_MS - 1)
    await wallet.setLastActiveTime()
    expect(wallet.isUnlocked()).toBe(true)

    // The time started over from that action.
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('does not lock on the unlock screen, where an action may overlap an unlock', async () => {
    await wallet.setLastActiveTime()
    await wallet.lockWallet()
    setLocked.mockClear()
    sleep(10 * MINUTES)

    // Typing the password: the unlock has not published yet, so the wallet
    // still reads locked, and the action must not queue a lock behind it.
    await wallet.setLastActiveTime()
    expect(setLocked).not.toHaveBeenCalled()
    // It armed the time again, for the session the unlock starts.
    keyring.state.isUnlocked = true
    sleep(DEFAULT_LOCK_MS - 1)
    await wallet.setLastActiveTime()
    expect(wallet.isUnlocked()).toBe(true)
  })

  it('applies an overdue auto-lock on waking, without a screen action', async () => {
    await wallet.setLastActiveTime()
    sleep(DEFAULT_LOCK_MS - 1)
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(false)
    expect(wallet.isUnlocked()).toBe(true)

    // The computer slept past the deadline; the paused timer has not run.
    sleep(10 * MINUTES)
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(true)
    expect(wallet.isUnlocked()).toBe(false)
    expect(broadcasts.sort()).toEqual([BUS_METHODS.AUTO_LOCKED, BUS_METHODS.LOCKED].sort())

    // Nothing is left to lock.
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    expect(setLocked).toHaveBeenCalledTimes(1)
  })

  it('does not apply an overdue auto-lock to a locked wallet', async () => {
    await wallet.setLastActiveTime()
    keyring.state.isUnlocked = false
    sleep(10 * MINUTES)
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(false)
    expect(setLocked).not.toHaveBeenCalled()
  })

  it('ends the auto-lock time on any lock, so its timer cannot lock a later unlock', async () => {
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(1 * MINUTES)
    await wallet.lockWallet()
    broadcasts = []
    setLocked.mockClear()

    // An unlock is under way (the automatic biometric prompt, say) when the
    // old session's time would have run out.
    keyring.holdLastStep(new Promise(() => undefined))
    void wallet.unlock('password').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    expect(setLocked).not.toHaveBeenCalled()
    expect(broadcasts).not.toContain(BUS_METHODS.AUTO_LOCKED)
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(false)
  })

  it('does not report an auto-lock when a timer armed on the unlock screen runs out', async () => {
    await wallet.lockWallet()
    broadcasts = []
    setLocked.mockClear()
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    expect(setLocked).not.toHaveBeenCalled()
    expect(broadcasts).toEqual([])
  })

  it('does not lock during first-time onboarding, before a vault exists', async () => {
    keyring.state.hasVault = false
    await wallet.setLastActiveTime()
    sleep(10 * MINUTES)
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(false)
    // A screen action starts the time over instead.
    await wallet.setLastActiveTime()
    expect(wallet.isUnlocked()).toBe(true)
    expect(setLocked).not.toHaveBeenCalled()
  })

  it('uses the new auto-lock time for the deadline once it is changed', async () => {
    await wallet.setAutoLockTimeId(SHORTEST_LOCK_ID)
    sleep(SHORTEST_LOCK_MS)
    await wallet.setLastActiveTime()
    expect(wallet.isUnlocked()).toBe(false)
  })
})

describe('the system lock', () => {
  it.each([
    ['computer-locked', 'setLockOnComputerLock'],
    ['windows-closed', 'setLockOnWindowsClosed'],
  ] as const)('locks on %s with its setting on', async (event, setter) => {
    await wallet[setter](true)
    await expect(wallet.lockOnSystemEvent(event)).resolves.toBe(true)
    expect(wallet.isUnlocked()).toBe(false)
    expect(setLocked).toHaveBeenCalledTimes(1)
    expect(broadcasts).toEqual([BUS_METHODS.LOCKED])
  })

  it.each([
    ['computer-locked', 'setLockOnComputerLock'],
    ['windows-closed', 'setLockOnWindowsClosed'],
  ] as const)('does not lock on %s with its setting off', async (event, setter) => {
    await wallet[setter](false)
    await expect(wallet.lockOnSystemEvent(event)).resolves.toBe(false)
    expect(wallet.isUnlocked()).toBe(true)
    expect(setLocked).not.toHaveBeenCalled()
  })

  it('keeps each setting to its own event', async () => {
    await wallet.setLockOnComputerLock(false)
    await expect(wallet.lockOnSystemEvent('windows-closed')).resolves.toBe(true)

    keyring.state.isUnlocked = true
    await wallet.setLockOnComputerLock(true)
    await wallet.setLockOnWindowsClosed(false)
    await expect(wallet.lockOnSystemEvent('computer-locked')).resolves.toBe(true)
    await expect(wallet.lockOnSystemEvent('windows-closed')).resolves.toBe(false)
  })

  it('has both settings on for preferences stored before they existed', async () => {
    adapter.disk.set('preference', JSON.stringify({ autoLockTimeId: 5, locale: 'ja' }))
    await preferenceService.init({ storage: adapter as any, logger })

    await expect(wallet.getLockOnComputerLock()).resolves.toBe(true)
    await expect(wallet.getLockOnWindowsClosed()).resolves.toBe(true)
    await expect(wallet.lockOnSystemEvent('computer-locked')).resolves.toBe(true)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it.each(['computer-locked', 'windows-closed'] as const)(
    'does not lock on %s during first-time onboarding, before a vault exists',
    async event => {
      // The password is set and the onboarding screens still create or
      // restore the wallet: locking now would leave nothing to unlock again.
      keyring.state.hasVault = false
      await expect(wallet.lockOnSystemEvent(event)).resolves.toBe(false)
      expect(wallet.isUnlocked()).toBe(true)
      expect(setLocked).not.toHaveBeenCalled()

      // Once the wallet exists, the system lock applies.
      keyring.state.hasVault = true
      await expect(wallet.lockOnSystemEvent(event)).resolves.toBe(true)
      expect(wallet.isUnlocked()).toBe(false)
    }
  )

  it('locks even while the wallet reads locked, so an unlock under way ends locked', async () => {
    // submitPassword publishes the unlock only at its end; the keyring skips
    // that publication while a lock is pending (see submit-password.test.ts).
    keyring.state.isUnlocked = false
    await expect(wallet.lockOnSystemEvent('computer-locked')).resolves.toBe(true)
    expect(setLocked).toHaveBeenCalledTimes(1)
  })

  it('has nothing to lock before the keyring has started', async () => {
    keyring.service.memStore = undefined
    await expect(wallet.lockOnSystemEvent('computer-locked')).resolves.toBe(false)
    expect(setLocked).not.toHaveBeenCalled()
  })

  it('locks when the settings cannot be read', async () => {
    vi.spyOn(preferenceService, 'getLockOnWindowsClosed').mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'lockOnWindowsClosed')")
    })
    await expect(wallet.lockOnSystemEvent('windows-closed')).resolves.toBe(true)
    expect(wallet.isUnlocked()).toBe(false)
  })
})

describe('the onboarding and recovery keepalive', () => {
  /** What useWalletKeepalive does while its screen is open: refresh every ten seconds. */
  function keepalive() {
    const interval = setInterval(() => {
      void wallet.setLastActiveTime()
    }, KEEPALIVE_INTERVAL_MS)
    return () => clearInterval(interval)
  }

  beforeEach(async () => {
    await wallet.setAutoLockTimeId(SHORTEST_LOCK_ID)
  })

  it('holds the shortest auto-lock off while it refreshes', async () => {
    const stop = keepalive()
    await vi.advanceTimersByTimeAsync(5 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)
    stop()
    await vi.advanceTimersByTimeAsync(SHORTEST_LOCK_MS)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('gives way to the computer locking, and its refreshes do not undo the lock', async () => {
    const stop = keepalive()
    await vi.advanceTimersByTimeAsync(1 * MINUTES)
    await wallet.lockOnSystemEvent('computer-locked')
    expect(wallet.isUnlocked()).toBe(false)

    await vi.advanceTimersByTimeAsync(2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(false)
    expect(setLocked).toHaveBeenCalledTimes(1)
    stop()
  })

  it('gives way to the last window closing', async () => {
    const stop = keepalive()
    await vi.advanceTimersByTimeAsync(1 * MINUTES)
    await wallet.lockOnSystemEvent('windows-closed')
    await vi.advanceTimersByTimeAsync(1 * MINUTES)
    expect(wallet.isUnlocked()).toBe(false)
    stop()
  })

  it('locks on its first refresh after the computer slept past the auto-lock time', async () => {
    const stop = keepalive()
    await vi.advanceTimersByTimeAsync(1 * MINUTES)
    sleep(2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS)
    expect(wallet.isUnlocked()).toBe(false)
    expect(broadcasts).toContain(BUS_METHODS.AUTO_LOCKED)
    stop()
  })
})

describe('an unlock and a lock that comes in meanwhile', () => {
  beforeEach(() => {
    keyring.state.isUnlocked = false
  })

  it('unlocks when no lock comes in', async () => {
    await expect(wallet.unlock('password')).resolves.toBeUndefined()
    expect(wallet.isUnlocked()).toBe(true)
    expect(broadcasts).not.toContain(BUS_METHODS.LOCKED)
  })

  it('ends locked when the computer locks while the unlock waits its turn', async () => {
    const release = holdChainStateQueue()
    const unlocking = wallet.unlock('password')
    const outcome = unlocking.then(
      () => 'unlocked',
      error => error
    )
    await wallet.lockOnSystemEvent('computer-locked')
    // By the time the unlock runs, the lock has finished: the keyring
    // service's own pending-lock check no longer sees it.
    release()

    await expect(outcome).resolves.toMatchObject(LOCKED_DURING_UNLOCK)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('ends locked when the last window closes during the unlock\'s last step', async () => {
    let finishLastStep: () => void = () => undefined
    keyring.holdLastStep(new Promise<void>(resolve => (finishLastStep = resolve)))
    const outcome = wallet.unlock('password').then(
      () => 'unlocked',
      error => error
    )
    await vi.waitFor(() => expect(keyring.state.submitting).toBe(true))
    await wallet.lockOnSystemEvent('windows-closed')
    finishLastStep()

    await expect(outcome).resolves.toMatchObject(LOCKED_DURING_UNLOCK)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('ends locked when the keyring service locks on its own during the unlock', async () => {
    let finishLastStep: () => void = () => undefined
    keyring.holdLastStep(new Promise<void>(resolve => (finishLastStep = resolve)))
    const outcome = wallet.unlock('password').then(
      () => 'unlocked',
      error => error
    )
    await vi.waitFor(() => expect(keyring.state.submitting).toBe(true))
    await keyring.service.setLocked()
    finishLastStep()

    await expect(outcome).resolves.toMatchObject(LOCKED_DURING_UNLOCK)
  })

  it('lets an unlock called after the lock go through', async () => {
    await wallet.lockOnSystemEvent('computer-locked')
    await expect(wallet.unlock('password')).resolves.toBeUndefined()
    expect(wallet.isUnlocked()).toBe(true)
  })
})
