import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUS_EVENTS, BUS_METHODS } from '@qbit/wallet-shared'

import { WalletController } from '../src/controllers/wallet'
import { preferenceService } from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'

// The keyring as the lock sees it: whether it reads unlocked, and setLocked.
// The rest of the background is the real one.
const keyring = vi.hoisted(() => {
  const state = { isUnlocked: true }
  const service = {
    keyrings: [],
    memStore: { getState: () => ({ ...state }) } as { getState(): { isUnlocked: boolean } } | undefined,
    setLocked: async () => {
      state.isUnlocked = false
      return { ...state }
    },
  }
  return { state, service }
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
  keyring.state.isUnlocked = true
  keyring.service.memStore = { getState: () => ({ ...keyring.state }) }
  setLocked = vi.spyOn(keyring.service, 'setLocked')
  broadcasts = []
  bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, record)
  wallet = new WalletController({ now: () => Date.now() })
})

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
