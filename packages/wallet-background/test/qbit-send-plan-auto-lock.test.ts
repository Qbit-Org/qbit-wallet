import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUTO_LOCK_SIGNING_GRACE_MS,
  AUTO_LOCK_SIGNING_HANDOFF_MS,
  WalletController,
} from '../src/controllers/wallet'
import { contactBookService, preferenceService } from '../src/services'

// The auto-lock while a send plan signs (#188): the plan's signing holds an
// auto-lock that falls due for its own ceiling, AUTO_LOCK_SIGNING_GRACE_MS
// plus twice its expected signing time past the deadline, which an end armed
// earlier for an ordinary signing must not cut short. The keyring is a stand-in
// for what the lock reads; the rest of the background is the real one.

const keyring = vi.hoisted(() => {
  const state = { isUnlocked: true }
  return {
    state,
    service: {
      keyrings: [],
      memStore: { getState: () => ({ isUnlocked: state.isUnlocked }) },
      hasVault: () => true,
      syncQbitHdPath: async () => false,
      setLocked: async () => {
        state.isUnlocked = false
        return { isUnlocked: false }
      },
    },
  }
})

vi.mock('../src/services', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services')>()),
  keyringService: keyring.service,
}))

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
const MINUTES = 60_000
const DEFAULT_LOCK_MS = 3 * MINUTES
const GRACE_MS = AUTO_LOCK_SIGNING_GRACE_MS
/** A plan expected to sign for five minutes: its ceiling is twenty minutes past the deadline. */
const PLAN_SIGNING_MS = 5 * MINUTES
const PLAN_CEILING_MS = GRACE_MS + 2 * PLAN_SIGNING_MS

let wallet: WalletController

beforeEach(async () => {
  vi.useFakeTimers()
  await preferenceService.init({ storage: new DiskAdapter() as any, logger })
  keyring.state.isUnlocked = true
  wallet = new WalletController({ now: () => Date.now() })
  vi.spyOn(contactBookService, 'listAlias').mockReturnValue([{} as any])
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A page's signing call, until `finish` ends it with signed bytes. */
function pageSigning(page = 'popup:1') {
  const signing = (wallet as any).beginLocalSigning(page)
  return {
    finish: async () => {
      ;(wallet as any).endLocalSigning(signing, true)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

/** A send plan's signing, holding the auto-lock as the engine does, until `release` ends it. */
function planSigning(): () => void {
  return (wallet as any).holdAutoLockForQbitSendPlan(PLAN_SIGNING_MS)
}

describe('the auto-lock while a send plan signs', () => {
  it('holds for the plan’s ceiling when a page’s signing held the auto-lock first', async () => {
    await wallet.setLastActiveTime()
    const page = pageSigning()
    // The deadline passes while the page signs: held for the ordinary ten minutes.
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + 2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)
    planSigning()
    await page.finish()

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(PLAN_CEILING_MS - GRACE_MS - 2 * MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('holds for the plan’s ceiling when a page is owed its minute as the deadline passes', async () => {
    await wallet.setLastActiveTime()
    // A page's signing ends just before the deadline: it is owed the minute
    // after it, and the end of that wait is armed.
    const page = pageSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 30_000)
    await page.finish()
    planSigning()

    await vi.advanceTimersByTimeAsync(30_000 + GRACE_MS + AUTO_LOCK_SIGNING_HANDOFF_MS)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(PLAN_CEILING_MS - GRACE_MS - AUTO_LOCK_SIGNING_HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('keeps the plan’s ceiling when a page signs after the plan held the auto-lock', async () => {
    await wallet.setLastActiveTime()
    planSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    const page = pageSigning()
    await vi.advanceTimersByTimeAsync(MINUTES)
    await page.finish()

    await vi.advanceTimersByTimeAsync(PLAN_CEILING_MS - 2 * MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('never holds past the plan’s ceiling, whatever the wall clock does', async () => {
    await wallet.setLastActiveTime()
    const page = pageSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    planSigning()
    await page.finish()
    vi.setSystemTime(Date.now() - 60 * MINUTES)
    // A second plan signing would move the end only for its own ceiling.
    await vi.advanceTimersByTimeAsync(PLAN_CEILING_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('holds no longer once the plan’s signing ends: past the deadline and the page’s minute, it locks', async () => {
    await wallet.setLastActiveTime()
    const page = pageSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    const release = planSigning()
    await page.finish()
    await vi.advanceTimersByTimeAsync(2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('holds a page’s signing that outlives the plan’s no longer than an ordinary signing’s hold', async () => {
    await wallet.setLastActiveTime()
    const page = pageSigning()
    const release = planSigning()
    // The deadline passes while both sign: held for the plan's ceiling.
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + 2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)
    // The plan's signing ends; the page's goes on, held as an ordinary
    // signing is: ten minutes past the deadline.
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(GRACE_MS - 2 * MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
    await page.finish()
  })

  it('bounds that hold from when it was armed, whatever the wall clock does', async () => {
    await wallet.setLastActiveTime()
    const page = pageSigning()
    const release = planSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + 2 * MINUTES)
    release()
    await vi.advanceTimersByTimeAsync(0)
    // The wall clock goes back an hour: the page's signing gains nothing.
    vi.setSystemTime(Date.now() - 60 * MINUTES)
    await vi.advanceTimersByTimeAsync(GRACE_MS - 2 * MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
    await page.finish()
  })

  it('still locks at once on the lock button, a computer lock and the last window closing', async () => {
    for (const lock of [
      () => wallet.lockWallet(),
      () => wallet.lockOnSystemEvent('computer-locked'),
      () => wallet.lockOnSystemEvent('windows-closed'),
    ]) {
      keyring.state.isUnlocked = true
      await wallet.setLastActiveTime()
      const page = pageSigning()
      await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
      const release = planSigning()
      await page.finish()
      await lock()
      expect(wallet.isUnlocked()).toBe(false)
      release()
    }
  })
})
