import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUS_EVENTS, BUS_METHODS, ErrorCodes } from '@qbit/wallet-shared'

import {
  AUTO_LOCK_SIGNING_GRACE_MS,
  AUTO_LOCK_SIGNING_HANDOFF_MS,
  WalletController,
} from '../src/controllers/wallet'
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

describe('the auto-lock during a local signing (#171)', () => {
  const HANDOFF_MS = AUTO_LOCK_SIGNING_HANDOFF_MS
  const GRACE_MS = AUTO_LOCK_SIGNING_GRACE_MS

  /** A local signing call for page `page` (null: through no page), until the test calls `finish`. */
  function startSigning(page: string | null = 'popup:1') {
    const signing = (wallet as any).beginLocalSigning(page ?? undefined)
    return {
      /** Ends the call; `signed`: it handed back signed bytes. */
      finish: async (signed = true) => {
        ;(wallet as any).endLocalSigning(signing, signed)
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  it('waits for the signing, then locks a minute after it ends', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()

    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + 2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)
    expect(setLocked).not.toHaveBeenCalled()

    await signing.finish()
    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
    expect(broadcasts.sort()).toEqual([BUS_METHODS.AUTO_LOCKED, BUS_METHODS.LOCKED].sort())
  })

  it('leaves a deadline the signing did not reach alone: signing is not a screen action', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(MINUTES)
    await signing.finish()

    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('locks anyway ten minutes past the deadline', async () => {
    await wallet.setLastActiveTime()
    startSigning()

    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + GRACE_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
    expect(broadcasts).toContain(BUS_METHODS.AUTO_LOCKED)
  })

  it('never lets back-to-back signings stretch the wait past ten minutes from the deadline', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + 4 * MINUTES)
    await first.finish()
    // The next transaction of a batch starts at once, and runs on.
    startSigning()

    await vi.advanceTimersByTimeAsync(6 * MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('lets no screen action after the deadline start the time over during the wait', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    // Past the deadline, as after a computer that slept nine minutes.
    sleep(DEFAULT_LOCK_MS + 9 * MINUTES)

    await wallet.setLastActiveTime()
    expect(wallet.isUnlocked()).toBe(true)
    await signing.finish()

    // Held until a minute after the signing, the session ends as it would have.
    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('keeps the minute after the signing when screen actions come in it', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await signing.finish()
    await vi.advanceTimersByTimeAsync(30 * SECONDS)

    await wallet.setLastActiveTime()
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(30 * SECONDS)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('gives the minute after the signing when the deadline falls inside it', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 5 * SECONDS)
    await signing.finish()

    // The deadline passes 5 s later; the page still has the minute.
    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('starts the time over on a screen action in that minute before the deadline', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 5 * SECONDS)
    await signing.finish()

    // Before the deadline the session's time has not passed.
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('locks at once when its page closes in the minute after the signing', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await signing.finish()

    await wallet.onUiPortDisconnected('tab:9')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(true)

    await wallet.onUiPortDisconnected('popup:1')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it("keeps a page's minute after its signing when another page's signing is stopped", async () => {
    await wallet.setLastActiveTime()
    const first = startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await first.finish()
    // Within that minute another page starts a signing, then closes.
    startSigning('tab:2')
    await wallet.onUiPortDisconnected('tab:2')
    await vi.advanceTimersByTimeAsync(0)

    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(HANDOFF_MS)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('keeps the minute for an earlier page when the page whose signing ended last closes', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning('popup:1')
    const second = startSigning('tab:2')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await first.finish()
    await vi.advanceTimersByTimeAsync(SECONDS)
    await second.finish()

    // The second page closes; the first may still be handing its result off.
    await wallet.onUiPortDisconnected('tab:2')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(true)

    await wallet.onUiPortDisconnected('popup:1')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('locks at once when the last page anything was held for closes', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await first.finish()
    // Another page signs; the first page closes, then the other one.
    startSigning('tab:2')
    await wallet.onUiPortDisconnected('popup:1')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(true)

    await wallet.onUiPortDisconnected('tab:2')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('gives the minute after a held signing even after the wall clock moved backwards', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    // The clock is set back an hour while the signing holds the auto-lock.
    vi.setSystemTime(Date.now() - 60 * MINUTES)

    await signing.finish()
    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('owes no minute to a page whose signing ended well before the deadline', async () => {
    await wallet.setLastActiveTime()
    const early = startSigning('popup:1')
    const late = startSigning('tab:2')
    await vi.advanceTimersByTimeAsync(MINUTES)
    await early.finish()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    await late.finish()

    await wallet.onUiPortDisconnected('tab:2')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('leaves a page only its own minute when another owed page closes', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning('popup:1')
    const second = startSigning('tab:2')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await first.finish()
    // The first page's minute passes while the second still signs.
    await vi.advanceTimersByTimeAsync(5 * MINUTES)
    await second.finish()

    await wallet.onUiPortDisconnected('tab:2')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('keeps an overdue hold when the auto-lock setting changes during it', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)

    await wallet.setAutoLockTimeId(7)
    await signing.finish()

    await vi.advanceTimersByTimeAsync(HANDOFF_MS)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('arms the deadline for no longer than the auto-lock time when the last owed page closes', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 30 * SECONDS)
    await signing.finish()
    // The clock is set back a day, then the page closes within its minute.
    vi.setSystemTime(Date.now() - 24 * 60 * MINUTES)
    await wallet.onUiPortDisconnected('popup:1')

    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it("keeps a page's minute when another page's signing is stopped before the deadline", async () => {
    await wallet.setLastActiveTime()
    const first = startSigning('popup:1')
    startSigning('tab:2')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 20 * SECONDS)
    // The first page's signing ends 20 s before the deadline; it is owed its minute.
    await first.finish()
    await vi.advanceTimersByTimeAsync(10 * SECONDS)
    await wallet.onUiPortDisconnected('tab:2')

    await vi.advanceTimersByTimeAsync(10 * SECONDS + 40 * SECONDS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('gives the minute after a held signing that failed, so its page can say why', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)

    await signing.finish(false)

    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('owes no minute to a signing that fails before the deadline', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 30 * SECONDS)

    // Nothing was signed, so nothing is handed off: the deadline stands.
    await signing.finish(false)

    await vi.advanceTimersByTimeAsync(30 * SECONDS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  /** A broadcast by page `page`, pending until the test calls `answer`. */
  function startBroadcast(page = 'popup:1') {
    let answer: () => void = () => undefined
    const verdict = new Promise(
      resolve => (answer = () => resolve({ success: true, txid: 'ab'.repeat(32) }))
    )
    ;(wallet as any).attemptQbitBroadcast = () => verdict
    const broadcast = wallet.runForUiPort(page, () => wallet.broadcastQbitTx('00'))
    return {
      answer: async () => {
        answer()
        await broadcast
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  it('holds through the broadcast after a held signing, then gives the minute from its verdict', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await signing.finish()

    // A large transaction's broadcast outlasts the minute after its signing.
    const broadcast = startBroadcast()
    await vi.advanceTimersByTimeAsync(2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)

    await broadcast.answer()
    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('leaves the deadline alone for a broadcast whose page is owed nothing', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(MINUTES)
    await signing.finish()

    startBroadcast()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('holds for no broadcast from a page whose minute has run out', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning('popup:1')
    startSigning('tab:2')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    await first.finish()
    // The other page's signing runs on past the first page's minute.
    await vi.advanceTimersByTimeAsync(2 * MINUTES)
    startBroadcast('popup:1')

    await wallet.onUiPortDisconnected('tab:2')
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('lets no screen action start the time over when the clock moves back past a deadline in the minute after a signing', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    // It ends 30 s before the deadline: its page is owed the minute after it.
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 30 * SECONDS)
    await signing.finish()
    await vi.advanceTimersByTimeAsync(40 * SECONDS)
    vi.setSystemTime(Date.now() - 30 * SECONDS)

    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(20 * SECONDS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('keeps the ten minutes from the deadline when the clock moves back in the minute after a signing', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning()
    // It ends 30 s before the deadline: its page is owed the minute after it.
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 30 * SECONDS)
    await first.finish()
    startSigning()
    vi.setSystemTime(Date.now() - 60 * MINUTES)

    await vi.advanceTimersByTimeAsync(30 * SECONDS + GRACE_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('bounds the whole hold by its timers when the wall clock moves back', async () => {
    await wallet.setLastActiveTime()
    startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    vi.setSystemTime(Date.now() - 60 * MINUTES)

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('lets no later signing start the hold over after the wall clock moved back', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + 2 * MINUTES)
    vi.setSystemTime(Date.now() - 60 * MINUTES)
    await first.finish()
    // The next signing starts in the minute after the first, and runs on.
    startSigning()

    await vi.advanceTimersByTimeAsync(GRACE_MS - 2 * MINUTES - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('lets no screen action restart a held deadline after the wall clock moved back', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    vi.setSystemTime(Date.now() - 60 * MINUTES)

    await wallet.setLastActiveTime()
    await signing.finish()

    await vi.advanceTimersByTimeAsync(HANDOFF_MS)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('keeps an owed minute when a screen action sets a sooner deadline', async () => {
    await wallet.setAutoLockTimeId(SHORTEST_LOCK_ID)
    await wallet.setLastActiveTime()
    const signing = startSigning()
    // The signing ends 20 s before the 30 s deadline: its page is owed a minute.
    await vi.advanceTimersByTimeAsync(SHORTEST_LOCK_MS - 20 * SECONDS)
    await signing.finish()

    // A click 5 s later, before the deadline: its 30 s would end before the minute.
    await vi.advanceTimersByTimeAsync(5 * SECONDS)
    await wallet.setLastActiveTime()
    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 5 * SECONDS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('goes back to the deadline when its page closes in the minute before it', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - 30 * SECONDS)
    await signing.finish()

    await wallet.onUiPortDisconnected('popup:1')
    await vi.advanceTimersByTimeAsync(30 * SECONDS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('waits for the last of several signings', async () => {
    await wallet.setLastActiveTime()
    const first = startSigning()
    const second = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)

    await first.finish()
    await vi.advanceTimersByTimeAsync(2 * MINUTES)
    expect(wallet.isUnlocked()).toBe(true)

    await second.finish()
    await vi.advanceTimersByTimeAsync(HANDOFF_MS)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('holds on waking within the wait, and locks on waking past it', async () => {
    await wallet.setLastActiveTime()
    startSigning()

    sleep(DEFAULT_LOCK_MS + MINUTES)
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(false)
    expect(wallet.isUnlocked()).toBe(true)

    sleep(GRACE_MS)
    await expect(wallet.lockIfAutoLockOverdue()).resolves.toBe(true)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('locks when a signing ends after the computer slept past the wait', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    // The wait ends by the wall clock while the computer sleeps.
    sleep(GRACE_MS)

    await signing.finish()

    expect(wallet.isUnlocked()).toBe(false)
    expect(setLocked).toHaveBeenCalledTimes(1)
  })

  it('gives a deadline missed during a sleep the same minute after the signing', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    // The deadline passes while the computer sleeps, and the timer has not run.
    sleep(DEFAULT_LOCK_MS + MINUTES)

    await signing.finish()
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(HANDOFF_MS - 1)
    expect(wallet.isUnlocked()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('locks when a signing ends after an unseen deadline and the wait both passed in a sleep', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    sleep(DEFAULT_LOCK_MS + GRACE_MS)

    await signing.finish()

    expect(wallet.isUnlocked()).toBe(false)
    expect(setLocked).toHaveBeenCalledTimes(1)
  })

  it('locks at once when the only page waiting for the signing closes during the wait', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)
    expect(wallet.isUnlocked()).toBe(true)

    await wallet.onUiPortDisconnected('popup:1')
    await vi.advanceTimersByTimeAsync(0)

    expect(wallet.isUnlocked()).toBe(false)
    expect(broadcasts).toContain(BUS_METHODS.AUTO_LOCKED)
    // The stopped signing ending later changes nothing.
    await signing.finish()
    expect(setLocked).toHaveBeenCalledTimes(1)
  })

  it('leaves the time alone for a signing whose page closed', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(MINUTES)
    await wallet.onUiPortDisconnected('popup:1')
    await signing.finish()

    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS - MINUTES)
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('keeps holding for a signing whose page stays open when another page closes', async () => {
    await wallet.setLastActiveTime()
    startSigning('popup:1')
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS + MINUTES)

    await wallet.onUiPortDisconnected('tab:2')
    await vi.advanceTimersByTimeAsync(0)

    expect(wallet.isUnlocked()).toBe(true)
  })

  it('does not hold for a signing that starts after its page closed', async () => {
    await wallet.setLastActiveTime()
    await wallet.onUiPortDisconnected('popup:1')
    const signing = startSigning('popup:1')

    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    expect(wallet.isUnlocked()).toBe(false)

    await signing.finish()
    expect(setLocked).toHaveBeenCalledTimes(1)
  })

  it('does not hold for a signing that came through no page', async () => {
    await wallet.setLastActiveTime()
    startSigning(null)

    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)

    expect(wallet.isUnlocked()).toBe(false)
  })

  it('lets the lock button and the computer locking lock at once', async () => {
    await wallet.setLastActiveTime()
    const signing = startSigning()
    await wallet.lockWallet()
    expect(wallet.isUnlocked()).toBe(false)

    keyring.state.isUnlocked = true
    await wallet.setLastActiveTime()
    await expect(wallet.lockOnSystemEvent('computer-locked')).resolves.toBe(true)
    expect(wallet.isUnlocked()).toBe(false)

    // The signing that a lock stopped ends with nothing to start.
    await signing.finish()
    await vi.advanceTimersByTimeAsync(DEFAULT_LOCK_MS)
    expect(setLocked).toHaveBeenCalledTimes(2)
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
