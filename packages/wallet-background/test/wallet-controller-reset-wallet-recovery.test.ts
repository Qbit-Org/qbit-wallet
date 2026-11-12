import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyringType } from '@qbit/keyring-service/types'
import { BUS_EVENTS, ErrorCodes } from '@qbit/wallet-shared'
import { BaseProxyStorageAdapter } from '@qbit/wallet-storage'
import { AddressType } from '@qbit/wallet-types'
import log from 'loglevel'
import { WalletController } from '../src/controllers/wallet'
import {
  biometricUnlockService,
  contactBookService,
  permissionService,
  phishingDetectService,
  preferenceService,
} from '../src/services'
import { bgEventBus } from '../src/utils/eventBus'

// The recovery risks a reset asks the user to acknowledge, over Qbit HD
// wallets as the keyring service lists them; the rest of the background is
// the real one. The removal tests show the same acknowledgement for one wallet.
const keyrings = vi.hoisted(() => {
  type FakeKeyring = {
    type: string
    addressType: number
    accounts: string[]
    hdPath?: string
    /** Account metadata without addresses, so the wallet lists as corrupted. */
    unreadable?: boolean
    recovery?: unknown
    getAccounts(): Promise<string[]>
    getQbitRecoveryState(): unknown
  }
  const QBIT_HD = 'Qbit HD Key Tree'
  const live: FakeKeyring[] = []
  const state = { booted: true, vault: true, unlocked: true }
  let ids = 0

  const keyring = (accounts: string[]): FakeKeyring => {
    const created: FakeKeyring = {
      type: QBIT_HD,
      addressType: 9,
      accounts,
      hdPath: "m/87'/0'/0'/0",
      getAccounts: async () => created.accounts,
      getQbitRecoveryState: () => structuredClone(created.recovery),
    }
    return created
  }
  const nextId = () => (++ids).toString(16).padStart(2, '0').repeat(32)
  const addresses = (id: string) => ({
    mainnet: `qb1z${id.slice(0, 16)}`,
    testnet4: `tq1z${id.slice(0, 16)}`,
    signet: `tq1z${id.slice(0, 16)}`,
    regtest: `qbrt1z${id.slice(0, 16)}`,
  })
  const display = (shown: FakeKeyring, index: number) => ({
    type: shown.type,
    index,
    addressType: shown.addressType,
    keyring: { hdPath: shown.hdPath },
    accounts: shown.accounts.map(id => ({
      pubkey: id,
      brandName: shown.type,
      keyring: {
        pubkey: id,
        path: "m/87'/0'/0'/0/0",
        scriptPubKey: `5220${id}`,
        leafScript: `20${id}b3`,
        ...(shown.unreadable ? {} : { addresses: addresses(id) }),
        hkdf: { account: 0, change: 0, index: 0 },
        signatureCounter: { count: 0, limit: 1073741824, remaining: 1073741824, state: 'normal' },
      },
    })),
  })

  // A keyring service that keeps one wallet's password, locks as the real one
  // does (no vault write after it), and erases on resetAllData.
  const service = {
    keyrings: live,
    memStore: { getState: () => ({ isUnlocked: state.unlocked }) },
    getAllDisplayedKeyrings: vi.fn(async () =>
      state.unlocked ? live.map((shown, index) => display(shown, index)) : []
    ),
    getQbitRecoveryVaultState: vi.fn(async (address: string) =>
      live
        .find(
          shown =>
            !shown.unreadable &&
            shown.accounts.some(id => Object.values(addresses(id)).includes(address))
        )
        ?.getQbitRecoveryState()
    ),
    createTmpKeyring: vi.fn(() => {
      throw new Error('every wallet in these tests is on the recorded path')
    }),
    isBooted: () => state.booted,
    hasVault: () => state.vault,
    verifyPassword: vi.fn(async (password: string) => password === 'password'),
    setLocked: vi.fn(async () => {
      state.unlocked = false
    }),
    persistAllKeyrings: vi.fn(async () => {
      if (state.unlocked) return true
      throw new Error('keyringcontroller_password_is_not_a_string')
    }),
    resetAllData: vi.fn(async () => {
      state.booted = false
      state.vault = false
      state.unlocked = false
      live.length = 0
    }),
  }

  return {
    QBIT_HD,
    service,
    state,
    live,
    keyring,
    nextId,
    addresses,
    reset() {
      live.length = 0
      ids = 0
      Object.assign(state, { booted: true, vault: true, unlocked: true })
    },
  }
})

vi.mock('../src/services', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services')>()),
  keyringService: keyrings.service,
}))

class Disk extends BaseProxyStorageAdapter {
  readonly values = new Map<string, string>()

  async get(key: string): Promise<any> {
    const raw = this.values.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  async set(key: string, value: any): Promise<void> {
    const raw = JSON.stringify(value)
    if (raw === undefined) this.values.delete(key)
    else this.values.set(key, raw)
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() }
const PASSWORD = 'password'

let wallet: WalletController
let announced: string[]
const recordAnnouncement = ({ method }: { method: string }) => announced.push(method)

/** A wallet in the next slot; returns its first account's id. */
function addWallet(): string {
  const id = keyrings.nextId()
  keyrings.live.push(keyrings.keyring([id]))
  return id
}

/** A record of the wallet it is set on sweeping into `destinationId`, in slot `destinationKeyringIndex`. */
function migration(
  status: 'migrating' | 'migrated',
  destinationKeyringIndex: number,
  destinationId: string,
  plans: { status: string }[] = []
) {
  return {
    version: 2,
    acknowledgement: 'accepted',
    networks: {
      mainnet: {
        status,
        addressDiscoveryComplete: true,
        migration: {
          destinationKeyringIndex,
          destinationPubkey: destinationId,
          destinationAddress: keyrings.addresses(destinationId).mainnet,
          network: 'mainnet',
          plans,
        },
      },
    },
  }
}

/**
 * Four wallets: the one in slot 0 is sweeping into slot 1, and the one in slot
 * 2 has swept into slot 3, with a sweep broadcast and not yet confirmed.
 */
function twoMigrations() {
  addWallet()
  const firstDestination = addWallet()
  addWallet()
  const secondDestination = addWallet()
  keyrings.live[0]!.recovery = migration('migrating', 1, firstDestination)
  keyrings.live[2]!.recovery = migration('migrated', 3, secondDestination, [
    { status: 'broadcast' },
  ])
}

const SWEEPING = { role: 'source', network: 'mainnet', status: 'migrating' }
const SWEPT_INTO = { role: 'destination', network: 'mainnet', status: 'migrating' }
const SWEPT = { role: 'source', network: 'mainnet', status: 'migrated', hasInflightPlans: true }
const SWEPT_INTO_IN_FLIGHT = {
  role: 'destination',
  network: 'mainnet',
  status: 'migrated',
  hasInflightPlans: true,
}

/** The reasons of a refused reset, as the page receives them: as JSON. */
async function refusedReasons(reset: Promise<void>): Promise<any[]> {
  const error: any = await reset.catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: ErrorCodes.QBIT_RECOVERY_REMOVAL_ACK_REQUIRED })
  return JSON.parse(JSON.stringify(error.data.reasons))
}

function expectNothingErased() {
  expect(keyrings.service.setLocked).not.toHaveBeenCalled()
  expect(keyrings.service.resetAllData).not.toHaveBeenCalled()
  expect(keyrings.state).toEqual({ booted: true, vault: true, unlocked: true })
  expect(preferenceService.getWalletResetPending()).toBe(false)
  expect(announced).toEqual([])
}

beforeEach(async () => {
  vi.clearAllMocks()
  keyrings.reset()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.spyOn(log, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const disk = new Disk()
  await preferenceService.init({ storage: disk, logger })
  await biometricUnlockService.init({ storage: disk, logger })
  await permissionService.init({ storage: disk, logger, autoSync: true })
  ;(contactBookService as any).initialized = false
  await contactBookService.init({ storage: disk, logger })
  phishingDetectService.destroy()
  await phishingDetectService.init({ adapter: disk, logger })
  wallet = new WalletController()
  announced = []
  bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, recordAnnouncement)
})

afterEach(() => {
  bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, recordAnnouncement)
})

describe('the recovery risks of a reset', () => {
  it('names those of every wallet together, each once, and erases nothing until they are acknowledged', async () => {
    twoMigrations()

    const reasons = await refusedReasons(wallet.resetWallet(PASSWORD))

    expect(reasons).toEqual([SWEEPING, SWEPT_INTO, SWEPT, SWEPT_INTO_IN_FLIGHT])
    expectNothingErased()
  })

  it('erases every wallet once all of them are acknowledged', async () => {
    twoMigrations()
    const reasons = await refusedReasons(wallet.resetWallet(PASSWORD))

    await expect(
      wallet.resetWallet(PASSWORD, {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: reasons,
      })
    ).resolves.toBeUndefined()

    expect(keyrings.service.resetAllData).toHaveBeenCalledOnce()
    expect(keyrings.state.booted).toBe(false)
  })

  it('asks again when the acknowledged risks no longer cover them, and erases nothing', async () => {
    addWallet()
    const destination = addWallet()
    keyrings.live[0]!.recovery = migration('migrating', 1, destination)
    const seen = await refusedReasons(wallet.resetWallet(PASSWORD))
    expect(seen).toEqual([SWEEPING, SWEPT_INTO])
    // Another window broadcasts a sweep while the confirmation is open.
    keyrings.live[0]!.recovery = migration('migrating', 1, destination, [{ status: 'broadcast' }])

    const fresh = await refusedReasons(
      wallet.resetWallet(PASSWORD, {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: seen,
      })
    )

    expect(fresh).toEqual([
      { ...SWEEPING, hasInflightPlans: true },
      { ...SWEPT_INTO, hasInflightPlans: true },
    ])
    expectNothingErased()
  })

  it.each([
    ['a flag left out', { acknowledgedQbitRecoveryReasons: [SWEEPING, SWEPT_INTO] }],
    [
      'a flag that is false',
      {
        acknowledgedQbitRecoveryRisks: false,
        acknowledgedQbitRecoveryReasons: [SWEEPING, SWEPT_INTO],
      },
    ],
    ['no reasons', { acknowledgedQbitRecoveryRisks: true }],
    [
      'reasons for another wallet',
      { acknowledgedQbitRecoveryRisks: true, acknowledgedQbitRecoveryReasons: [SWEPT] },
    ],
  ])('does not take %s as an acknowledgement', async (_label, options) => {
    addWallet()
    const destination = addWallet()
    keyrings.live[0]!.recovery = migration('migrating', 1, destination)

    const reasons = await refusedReasons(wallet.resetWallet(PASSWORD, options as any))

    expect(reasons).toEqual([SWEEPING, SWEPT_INTO])
    expectNothingErased()
  })

  it('checks the password before it reads any risk', async () => {
    twoMigrations()

    await expect(wallet.resetWallet('not the password')).rejects.toThrow('password_error')

    expect(keyrings.service.getQbitRecoveryVaultState).not.toHaveBeenCalled()
    expectNothingErased()
  })

  it('needs no acknowledgement when no wallet is part of a migration', async () => {
    addWallet()
    addWallet()

    await expect(wallet.resetWallet(PASSWORD)).resolves.toBeUndefined()

    expect(keyrings.service.resetAllData).toHaveBeenCalledOnce()
  })
})

describe('a reset of a wallet of another type', () => {
  it('finds no recovery risk to acknowledge', async () => {
    keyrings.live.push({ ...keyrings.keyring([keyrings.nextId()]), type: KeyringType.HdKeyring })
    keyrings.live[0]!.addressType = AddressType.P2WPKH

    await expect(wallet.resetWallet(PASSWORD)).resolves.toBeUndefined()

    expect(keyrings.service.getQbitRecoveryVaultState).not.toHaveBeenCalled()
    expect(keyrings.service.resetAllData).toHaveBeenCalledOnce()
  })
})

describe('a reset offered as the removal of the last usable wallet, beside corrupted wallets', () => {
  /** A wallet in the next slot that lists as corrupted: its accounts cannot be read. */
  function addCorruptedWallet() {
    keyrings.live.push({ ...keyrings.keyring([keyrings.nextId()]), unreadable: true })
  }
  const NOT_LAST_WALLET = { code: ErrorCodes.WALLET_RESET_NOT_LAST_WALLET }

  it('does not count a corrupted wallet as usable, as a removal does not', async () => {
    addWallet()
    addCorruptedWallet()
    const listed = JSON.parse(JSON.stringify(await wallet.getKeyrings()))
    expect(listed.map((keyring: any) => Boolean(keyring.isCorrupted))).toEqual([false, true])

    await expect(
      wallet.resetWallet(PASSWORD, { lastWalletKey: 'keyring_0' })
    ).resolves.toBeUndefined()

    expect(keyrings.service.resetAllData).toHaveBeenCalledOnce()
  })

  it('counts the usable wallet beside a corrupted one the page named', async () => {
    addCorruptedWallet()
    addWallet()

    await expect(
      wallet.resetWallet(PASSWORD, { lastWalletKey: 'keyring_0' })
    ).rejects.toMatchObject(NOT_LAST_WALLET)

    expectNothingErased()
  })

  it('judges the wallet the page named before it reads any recovery risk', async () => {
    twoMigrations()

    await expect(
      wallet.resetWallet(PASSWORD, { lastWalletKey: 'keyring_0' })
    ).rejects.toMatchObject(NOT_LAST_WALLET)

    expect(keyrings.service.getQbitRecoveryVaultState).not.toHaveBeenCalled()
    expectNothingErased()
  })

  it('asks for the recovery risks of the last wallet the page named', async () => {
    addWallet()
    const destination = addWallet()
    keyrings.live[0]!.recovery = migration('migrating', 1, destination)
    // The destination is corrupted: the source is the last usable wallet.
    keyrings.live[1]!.unreadable = true

    const reasons = await refusedReasons(
      wallet.resetWallet(PASSWORD, { lastWalletKey: 'keyring_0' })
    )

    expect(reasons.map(reason => reason.role)).toContain('source')
    expectNothingErased()
  })
})
