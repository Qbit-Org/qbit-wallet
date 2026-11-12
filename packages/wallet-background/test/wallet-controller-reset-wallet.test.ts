import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { init as initPqc } from '@qbit-oss/pqc'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { KeyringService, QbitSigningAbortedError } from '@qbit/keyring-service'
import { KeyringType } from '@qbit/keyring-service/types'
import { BUNDLED_PHISHING_DENYLIST } from '@qbit/phishing-detect'
import { PreferenceService } from '@qbit/preference-service'
import { transactionCore } from '@qbit/wallet-core'
import {
  BIOMETRIC_UNLOCK_RECORD_VERSION,
  BUS_EVENTS,
  BUS_METHODS,
  CHAINS_MAP,
  ErrorCodes,
  REGTEST_ACCESS_ACK_VERSION,
  bgI18n,
  SESSION_EVENTS,
  type BiometricUnlockRecord,
  type ToSignData,
} from '@qbit/wallet-shared'
import { BaseProxyStorageAdapter } from '@qbit/wallet-storage'
import { AddressType, ChainType } from '@qbit/wallet-types'
import log from 'loglevel'
import { getUiControllerMethod } from '../src/controllers/ui-access'
import { WalletController, type WalletControllerOptions } from '../src/controllers/wallet'
import {
  biometricUnlockService,
  contactBookService,
  keyringService,
  permissionService,
  phishingDetectService,
  preferenceService,
  qbitSendGuardService,
  regtestAccessService,
  sessionService,
} from '../src/services'
// The controller's own instance: it imports the service by the baseUrl path,
// which the tests resolve to a module of its own.
import approvalService from 'src/services/approval'
import { QBIT_SEND_PLAN_TICK_MS, type QbitSendPlanEngine } from '../src/services/qbitSendPlanEngine'
import qbitSendPlanStore, { QBIT_SEND_PLAN_STORE_KEY } from '../src/services/qbitSendPlanStore'
import { bgEventBus } from '../src/utils/eventBus'
import { FakeQbitExplorer, fakeTxid } from './qbit-fake-explorer'
import { ManualTimers, scriptOf } from './qbit-send-plan-engine-harness'

// The reset over the real background services, each keeping what it stores
// on one disk, as the extension's services share chrome.storage.local.

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type WriteMatch = (key: string, value: any) => boolean

// chrome.storage.local as every service sees it: JSON in, JSON out. A write
// can be held open until released, or made to fail.
class Disk extends BaseProxyStorageAdapter {
  readonly values = new Map<string, string>()
  readonly writes: { key: string; value: any }[] = []
  private holds: { match: WriteMatch; started: () => void; settled: Promise<void> }[] = []
  private releases: (() => void)[] = []
  private failures: { match: WriteMatch; left: number; error: Error }[] = []

  async get(key: string): Promise<any> {
    return this.read(key)
  }

  async set(key: string, value: any): Promise<void> {
    const raw = JSON.stringify(value)
    const copy = raw === undefined ? undefined : JSON.parse(raw)
    const hold = this.holds.find(candidate => candidate.match(key, copy))
    if (hold) {
      this.holds.splice(this.holds.indexOf(hold), 1)
      hold.started()
      await hold.settled
    }
    const failure = this.failures.find(
      candidate => candidate.left > 0 && candidate.match(key, copy)
    )
    if (failure) {
      failure.left -= 1
      throw failure.error
    }
    this.writes.push({ key, value: copy })
    if (raw === undefined) this.values.delete(key)
    else this.values.set(key, raw)
  }

  read(key: string): any {
    const raw = this.values.get(key)
    return raw === undefined ? undefined : JSON.parse(raw)
  }

  holdNextWrite(match: WriteMatch) {
    const started = deferred()
    const settled = deferred()
    this.holds.push({ match, started: started.resolve, settled: settled.promise })
    this.releases.push(settled.resolve)
    return { started: started.promise, release: settled.resolve }
  }

  failWrites(match: WriteMatch, times: number, error = new Error('disk full')) {
    this.failures.push({ match, left: times, error })
  }

  /** Storage recovers: no write fails any more. */
  stopFailing() {
    this.failures = []
  }

  /** Let every held write go, so nothing a test held stays queued. */
  releaseAll() {
    this.holds = []
    this.releases.splice(0).forEach(release => release())
  }
}

// It can hold the next save of the keyrings while they are encrypted.
class JsonEncryptor {
  private held: { started: () => void; settled: Promise<void> } | undefined
  private releases: (() => void)[] = []

  async encrypt(password: string, data: any): Promise<string> {
    const held = Array.isArray(data) ? this.held : undefined
    if (held) {
      this.held = undefined
      held.started()
      await held.settled
    }
    return JSON.stringify({ password, data })
  }

  async decrypt(password: string, encryptedData: string): Promise<any> {
    const parsed = JSON.parse(encryptedData)
    if (parsed.password !== password) throw new Error('bad password')
    return parsed.data
  }

  holdNextSave() {
    const started = deferred()
    const settled = deferred()
    this.held = { started: started.resolve, settled: settled.promise }
    this.releases.push(settled.resolve)
    return { started: started.promise, release: settled.resolve }
  }

  releaseAll() {
    this.held = undefined
    this.releases.splice(0).forEach(release => release())
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() }
const PASSWORD = 'password'
const NEW_PASSWORD = 'a new password'
const MNEMONIC = 'finish oppose decorate face calm tragic certain desk hour urge dinosaur mango'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const HD_PATH = "m/84'/0'/0'/0"
const SITE_A = 'https://a.example'
const SITE_B = 'https://b.example'
const CONTACT_ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'
const [BLOCKED_HOST, OTHER_BLOCKED_HOST] = BUNDLED_PHISHING_DENYLIST as unknown as [string, string]
const BIOMETRIC_RECORD: BiometricUnlockRecord = {
  version: BIOMETRIC_UNLOCK_RECORD_VERSION,
  credentialId: 'credential-id',
  prfSalt: 'prf-salt',
  wrappedPassword: 'wrapped-password',
  iv: 'iv',
  createdAt: 1,
}

const isVaultWrite: WriteMatch = (key, value) => key === 'keyringState' && Boolean(value?.vault)
const isEraseWrite: WriteMatch = (key, value) =>
  key === 'keyringState' && value?.booted === '' && value?.vault === null
const isBiometricWrite: WriteMatch = key => key === 'biometricUnlock'
const isPubkeyCacheErase: WriteMatch = (key, value) => key === 'cached_pubkeys' && value === null
/** How a wallet page's call held by a reset that erased the wallet ends. */
const CALL_REFUSED = 'Qbit Wallet was reset before this request ran, so it did not run'
/** How a wallet page's call held by a reset ends when its page closed meanwhile. */
const PAGE_CLOSED = 'The page that asked for this closed before it ran, so it did not run'

/** A Proceed session rule, as the phishing controller adds one. */
function proceedRule(id: number, hostname: string) {
  return {
    id,
    priority: 3,
    action: { type: 'allow' },
    condition: { requestDomains: [hostname], resourceTypes: ['main_frame'] },
  }
}

/** The warning page's redirect, a session rule that is no bypass. */
const WARNING_REDIRECT_RULE = {
  id: 1_000_000,
  priority: 2,
  action: { type: 'redirect', redirect: { extensionPath: '/index.html#/phishing' } },
  condition: { requestDomains: [BLOCKED_HOST], resourceTypes: ['main_frame'] },
}

let disk: Disk
let encryptor: JsonEncryptor
let wallet: WalletController
let browser: ReturnType<typeof createBrowser>
let uiMessages: { method: string; params: unknown }[]
const openPages: object[] = []

/** The parts of the extension API the reset reaches: session rules and the side panel. */
function createBrowser() {
  const state = { sessionRules: [] as any[] }
  const declarativeNetRequest = {
    RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow' },
    getSessionRules: vi.fn(async () => structuredClone(state.sessionRules)),
    updateSessionRules: vi.fn(
      async ({
        removeRuleIds = [],
        addRules = [],
      }: {
        removeRuleIds?: number[]
        addRules?: any[]
      }) => {
        state.sessionRules = [
          ...state.sessionRules.filter(rule => !removeRuleIds.includes(rule.id)),
          ...addRules,
        ]
      }
    ),
  }
  const sidePanel = { setPanelBehavior: vi.fn(async () => undefined) }
  return { state, declarativeNetRequest, sidePanel }
}

const recordUiMessage = (message: { method: string; params: unknown }) => {
  uiMessages.push(message)
}
const uiMethods = () => uiMessages.map(message => message.method)

/** A site's page with a session open, and what it is told, in order. */
function openSitePage(origin: string): [string, unknown][] {
  const key = { page: origin }
  const session = sessionService.getOrCreateSession(key) as any
  session.setProp({ origin, icon: '', name: origin })
  const told: [string, unknown][] = []
  session.pushMessage = (event: string, data: unknown) => told.push([event, data])
  openPages.push(key)
  return told
}

/** What the controller keeps of the wallets, which tests seed and inspect. */
const internals = () =>
  wallet as unknown as {
    qbitHistorySnapshots: Map<string, unknown>
    qbitConsolidationScans: Map<string, unknown>
    qbitConsolidationQueues: Map<string, unknown>
    qbitConsolidationBatches: Map<string, unknown>
    qbitUtxoSnapshotWaiters: Map<unknown, Map<string, AbortController>>
    pendingAccountDerivations: Set<string>
    localSignings: Set<unknown>
    autoLockHoldPages: Map<unknown, number>
    autoLockHoldEndsAt: number | undefined
    timer: unknown
  }

const createWallet = (mnemonic = MNEMONIC) =>
  wallet.createKeyringWithMnemonics(mnemonic, HD_PATH, '', AddressType.P2WPKH, 1)

/** Start every service from what is on the disk, as a worker start does. */
async function startServices() {
  await preferenceService.init({ storage: disk, logger })
  await keyringService.init({
    storage: disk as any,
    encryptor,
    logger,
    t: (key: string) => key,
    eventBus: { emit: vi.fn() } as any,
  })
  await biometricUnlockService.init({ storage: disk, logger })
  // As the background starts it: every change of a grant is saved.
  await permissionService.init({ storage: disk, logger, autoSync: true })
  ;(contactBookService as any).initialized = false
  await contactBookService.init({ storage: disk, logger })
  phishingDetectService.destroy()
  ;(phishingDetectService as any).temporaryWhitelist.clear()
  ;(phishingDetectService as any).permanentWhitelist.clear()
  await phishingDetectService.init({ adapter: disk, logger })
}

function newController(options?: WalletControllerOptions) {
  const controller = new WalletController(options)
  controller.initRegtestAccess({
    adapter: {
      isOptionalPermission: () => true,
      containsPermission: async () => true,
      onPermissionRemoved: () => undefined,
    },
    fetch: async () => {
      throw new Error('offline')
    },
  })
  return controller
}

/**
 * Everything a reset erases, on disk and in the services: two wallets with a
 * renamed account and a colored, renamed wallet, a language and a theme, other
 * preferences, the regtest consent, a biometric enrollment, two connected
 * sites, a contact, phishing bypasses of every kind and the background's own
 * message language.
 */
async function seedWalletData() {
  await createWallet()
  await createWallet(OTHER_MNEMONIC)
  preferenceService.setAccountAlianName('keyring_0#0', 'Spending')
  preferenceService.setKeyringAlianName('keyring_1', 'Savings')
  preferenceService.setKeyringColor('keyring_1', 'violet')
  await preferenceService.setLocale('fr')
  preferenceService.setThemeMode('dark')
  preferenceService.setDeveloperMode(true)
  preferenceService.setOpenInSidePanel(true)
  preferenceService.setCurrency('EUR')
  preferenceService.setShowSafeNotice(false)
  await preferenceService.setAutoLockTimeId(5)
  await preferenceService.setEnableRBF(false)
  preferenceService.setRegtestAccessAck(REGTEST_ACCESS_ACK_VERSION)
  await preferenceService.persist()
  await regtestAccessService.refresh({ verify: false })
  await biometricUnlockService.saveRecord(BIOMETRIC_RECORD, PASSWORD)
  await permissionService.addConnectedSite(SITE_A, 'A', '', ChainType.QBIT_MAINNET)
  await permissionService.addConnectedSite(SITE_B, 'B', '', ChainType.QBIT_TESTNET4)
  await contactBookService.addContact({
    name: 'Alice',
    address: CONTACT_ADDRESS,
    chain: ChainType.QBIT_MAINNET,
    isContact: true,
  })
  await phishingDetectService.addToPermanentWhitelist(BLOCKED_HOST)
  phishingDetectService.addToWhitelist(OTHER_BLOCKED_HOST)
  browser.state.sessionRules.push(proceedRule(5, OTHER_BLOCKED_HOST), WARNING_REDIRECT_RULE)
  await disk.set('i18nextLng', 'fr')
  // What the pages were told while all this was set up is not under test.
  uiMessages.length = 0
}

/** The preferences a new install starts with, as they are stored. */
async function defaultPreferences(): Promise<Record<string, unknown>> {
  const fresh = new Disk()
  const service = new PreferenceService()
  await service.init({ storage: fresh, logger })
  await service.persist()
  return fresh.read('preference')
}

/** The keyring states written after the first erase of the vault that hold a vault. */
function vaultWritesAfterErase(): unknown[] {
  const keyringWrites = disk.writes.filter(write => write.key === 'keyringState')
  const erasedAt = keyringWrites.findIndex(write => isEraseWrite('keyringState', write.value))
  expect(erasedAt).toBeGreaterThanOrEqual(0)
  return keyringWrites.slice(erasedAt + 1).filter(write => write.value?.vault)
}

/** Whether a keyring service started from this disk finds a wallet. */
async function diskHoldsAWallet(): Promise<boolean> {
  const restarted = new KeyringService()
  await restarted.init({ storage: disk as any, encryptor, logger, t: (key: string) => key })
  return restarted.isBooted() || restarted.hasVault()
}

/** A pending website approval, with how it settles. */
async function openApproval() {
  const closed = vi.spyOn(approvalService, 'platformCloseWindow').mockResolvedValue(undefined)
  const settled = approvalService
    .requestApproval({ params: { origin: SITE_A, name: 'A', icon: '' } } as any)
    .then(
      () => 'approved',
      (error: unknown) => error
    )
  await vi.waitFor(() => expect(approvalService.approvalWindowId).toBe(1))
  return { settled, closed }
}

/** A call from the page on UI port `port`: the allowlist, and arguments as the port carries them, as JSON. */
function viaPort(port: string, method: string, ...params: unknown[]): Promise<unknown> {
  const sent = JSON.parse(JSON.stringify(params))
  return Promise.resolve().then(() =>
    wallet.runForUiPort(port, () => getUiControllerMethod(wallet, method)(...sent), method)
  )
}

/** A call from the popup; see viaPort. */
function viaUiPort(method: string, ...params: unknown[]): Promise<unknown> {
  return viaPort('popup:1', method, ...params)
}

/**
 * A call from the popup that sends the id of the wallet it shows, as the
 * request's `walletId` field: left out when `walletId` is undefined, and
 * carried as JSON otherwise, as the port carries it.
 */
function viaPageShowing(walletId: unknown, method: string, ...params: unknown[]): Promise<unknown> {
  const sent = JSON.parse(JSON.stringify(params))
  const shown = walletId === undefined ? [] : [JSON.parse(JSON.stringify(walletId))]
  return Promise.resolve().then(() =>
    wallet.runForUiPort(
      'popup:1',
      () => getUiControllerMethod(wallet, method)(...sent),
      method,
      ...shown
    )
  )
}

/** Everything a reset could change that tests compare: disk and the services' own state. */
async function erasableState() {
  return {
    disk: Object.fromEntries([...disk.values.entries()].sort()),
    booted: keyringService.isBooted(),
    vault: keyringService.hasVault(),
    unlocked: wallet.isUnlocked(),
    keyrings: (await wallet.getKeyrings()).map(keyring => keyring.key),
    preferences: JSON.parse(JSON.stringify((preferenceService as any).store)),
    sites: permissionService.getConnectedSites().map(site => site.origin),
    contacts: contactBookService.listContacts().map(contact => contact.address),
    biometric: await biometricUnlockService.getStatus(),
    bypassed: [BLOCKED_HOST, OTHER_BLOCKED_HOST].filter(
      host => !phishingDetectService.checkPhishing(host).isPhishing
    ),
    sessionRules: structuredClone(browser.state.sessionRules),
    regtest: regtestAccessService.getStatus(),
    approval: approvalService.getApproval()?.id,
  }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.spyOn(log, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  browser = createBrowser()
  vi.stubGlobal('chrome', {
    declarativeNetRequest: browser.declarativeNetRequest,
    sidePanel: browser.sidePanel,
  })
  disk = new Disk()
  encryptor = new JsonEncryptor()
  await startServices()
  wallet = newController()
  await wallet.boot(PASSWORD)
  uiMessages = []
  bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, recordUiMessage)
})

afterEach(async () => {
  bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, recordUiMessage)
  disk.releaseAll()
  encryptor.releaseAll()
  openPages.splice(0).forEach(key => sessionService.deleteSession(key))
  const pending = approvalService.getApproval()
  if (pending) await approvalService.rejectApproval(pending.id)
  clearTimeout(internals().timer as any)
  await (wallet as any).chainStateChangeTail
  vi.unstubAllGlobals()
})

describe('a reset with the wrong password', () => {
  it('erases nothing, announces nothing and leaves the wallet unlocked', async () => {
    await seedWalletData()
    const siteA = openSitePage(SITE_A)
    const { settled } = await openApproval()
    const before = await erasableState()
    const pending = await Promise.race([settled, sleep(0).then(() => 'pending')])

    await expect(wallet.resetWallet('not the password')).rejects.toThrow('password_error')

    expect(await erasableState()).toEqual(before)
    expect(pending).toBe('pending')
    expect(await Promise.race([settled, sleep(0).then(() => 'pending')])).toBe('pending')
    expect(wallet.isUnlocked()).toBe(true)
    expect(siteA).toEqual([])
    expect(uiMethods()).toEqual([])
    expect(preferenceService.getWalletResetPending()).toBe(false)
  })
})

describe('a reset whose arguments are not what the page may send', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 123],
    ['an object', {}],
    ['an empty string', ''],
  ])(
    'refuses %s as the password over the UI port, and erases nothing',
    async (_label, password) => {
      await seedWalletData()
      const before = await erasableState()

      await expect(viaUiPort('resetWallet', password)).rejects.toThrow('password_error')

      expect(await erasableState()).toEqual(before)
      expect(uiMethods()).toEqual([])
    }
  )

  it.each([
    ['a string', 'acknowledged'],
    ['an array', [{ role: 'source' }]],
    ['a number', 1],
    ['true', true],
    ['a flag that is not a boolean', { acknowledgedQbitRecoveryRisks: 'yes' }],
    ['reasons that are not a list', { acknowledgedQbitRecoveryReasons: 'source' }],
    [
      'a reason that is not an object',
      { acknowledgedQbitRecoveryRisks: true, acknowledgedQbitRecoveryReasons: [null] },
    ],
    [
      'a reason of an unknown role',
      { acknowledgedQbitRecoveryRisks: true, acknowledgedQbitRecoveryReasons: [{ role: 'owner' }] },
    ],
    [
      'a reason of an unknown status',
      {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: [{ role: 'source', status: 'abandoned' }],
      },
    ],
    [
      'a reason whose in-flight mark is not a boolean',
      {
        acknowledgedQbitRecoveryRisks: true,
        acknowledgedQbitRecoveryReasons: [{ role: 'destination', hasInflightPlans: 'yes' }],
      },
    ],
    ['a last wallet named by a number', { lastWalletKey: 123 }],
    ['a last wallet named by an object', { lastWalletKey: {} }],
    ['a last wallet named by an empty string', { lastWalletKey: '' }],
  ])(
    'refuses options that are %s with the right password, and erases nothing',
    async (_label, options) => {
      await seedWalletData()
      const before = await erasableState()

      await expect(viaUiPort('resetWallet', PASSWORD, options)).rejects.toThrow(/Wallet reset/)

      expect(await erasableState()).toEqual(before)
      expect(uiMethods()).toEqual([])
    }
  )

  it('takes options a page left out, which arrive as null, and resets', async () => {
    await createWallet()

    await expect(viaUiPort('resetWallet', PASSWORD, undefined)).resolves.toBeUndefined()

    expect(keyringService.isBooted()).toBe(false)
  })
})

describe('a reset of a locked wallet', () => {
  it('is refused with the locked-wallet error, and erases nothing', async () => {
    await seedWalletData()
    await wallet.lockWallet()
    uiMessages.length = 0
    const before = await erasableState()

    await expect(wallet.resetWallet(PASSWORD)).rejects.toThrow('you_need_to_unlock_wallet_first')

    expect(await erasableState()).toEqual(before)
    expect(keyringService.isBooted()).toBe(true)
    expect(uiMethods()).toEqual([])
  })
})

describe('a reset with the right password', () => {
  it('leaves the extension as a new install would find it, the language and the theme apart', async () => {
    await seedWalletData()
    const { settled, closed } = await openApproval()
    const waiter = new AbortController()
    internals().qbitHistorySnapshots.set('history', {})
    internals().qbitConsolidationScans.set('scan', {})
    internals().qbitConsolidationQueues.set('scan', Promise.resolve())
    internals().qbitConsolidationBatches.set('txid', [1])
    internals().qbitUtxoSnapshotWaiters.set('popup:1', new Map([['read-1', waiter]]))
    internals().pendingAccountDerivations.add('derivation')
    await wallet.setLastActiveTime()
    expect(internals().timer).not.toBeNull()
    const defaults = await defaultPreferences()

    await expect(wallet.resetWallet(PASSWORD)).resolves.toBeUndefined()

    // The keys and the password.
    expect(keyringService.isBooted()).toBe(false)
    expect(keyringService.hasVault()).toBe(false)
    expect(disk.read('keyringState')).toMatchObject({ booted: '', vault: null })
    expect(disk.read('cached_pubkeys')).toBeNull()
    expect(await diskHoldsAWallet()).toBe(false)
    // The biometric unlock, the grants and the contacts.
    expect(disk.read('biometricUnlock')).toBeNull()
    expect(await biometricUnlockService.getStatus()).toEqual({ enrolled: false })
    expect(permissionService.getConnectedSites()).toEqual([])
    expect(disk.read('permission')).toMatchObject({ sites: [] })
    expect(disk.read('contactBook')).toEqual({})
    // Every preference at its default but the language and the theme, which
    // the background's own message language keeps agreeing with.
    expect(preferenceService.getLocale()).toBe('fr')
    expect(preferenceService.getThemeMode()).toBe('dark')
    await preferenceService.persist()
    expect(disk.read('preference')).toEqual({ ...defaults, locale: 'fr', themeMode: 'dark' })
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(disk.read('i18nextLng')).toBe('fr')
    expect(browser.sidePanel.setPanelBehavior).toHaveBeenLastCalledWith({
      openPanelOnActionClick: false,
    })
    // The phishing bypasses, stored and for the session, and the regtest consent.
    expect(disk.read('phishing_user_whitelist')).toEqual([])
    expect(phishingDetectService.checkPhishing(BLOCKED_HOST).isPhishing).toBe(true)
    expect(phishingDetectService.checkPhishing(OTHER_BLOCKED_HOST).isPhishing).toBe(true)
    expect(browser.state.sessionRules).toEqual([WARNING_REDIRECT_RULE])
    expect(preferenceService.getRegtestAccessAck()).toBeUndefined()
    expect(regtestAccessService.getStatus()).toMatchObject({ acknowledged: false, state: 'locked' })
    // The pending approval, its window closed.
    await expect(settled).resolves.toMatchObject({
      code: ErrorCodes.UserCancel,
      message: 'Qbit Wallet was reset',
    })
    expect(approvalService.getApproval()).toBeUndefined()
    expect(closed).toHaveBeenCalledWith(1)
    // What the controller kept of the wallets, and the auto-lock.
    expect(internals().qbitHistorySnapshots.size).toBe(0)
    expect(internals().qbitConsolidationScans.size).toBe(0)
    expect(internals().qbitConsolidationQueues.size).toBe(0)
    expect(internals().qbitConsolidationBatches.size).toBe(0)
    expect(internals().qbitUtxoSnapshotWaiters.size).toBe(0)
    expect(waiter.signal.aborted).toBe(true)
    expect(internals().pendingAccountDerivations.size).toBe(0)
    expect(internals().timer).toBeNull()
    // A new wallet can be set up from here.
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    expect((await wallet.getKeyrings()).map(keyring => keyring.accounts[0]!.alianName)).toEqual([
      'Account 1',
    ])
  })

  it('tells each connected site and every wallet page once, and announces no lock', async () => {
    await seedWalletData()
    const siteA = openSitePage(SITE_A)
    const siteB = openSitePage(SITE_B)
    const notConnected = openSitePage('https://c.example')

    await wallet.resetWallet(PASSWORD)

    for (const told of [siteA, siteB]) {
      expect(told).toEqual([
        [SESSION_EVENTS.accountsChanged, []],
        [SESSION_EVENTS.disconnect, expect.objectContaining({ code: 4900 })],
      ])
    }
    expect(notConnected).toEqual([])
    expect(uiMessages.filter(message => message.method === BUS_METHODS.WALLET_RESET)).toEqual([
      { method: BUS_METHODS.WALLET_RESET, params: {} },
    ])
    expect(uiMethods()).not.toContain(BUS_METHODS.LOCKED)
  })

  it('resolves again with nothing to erase, and announces nothing more', async () => {
    await seedWalletData()
    const siteA = openSitePage(SITE_A)
    await wallet.resetWallet(PASSWORD)
    // The preferences' debounced save, written now so it cannot land later.
    await preferenceService.persist()
    const told = siteA.length
    const announced = uiMessages.length
    const writes = disk.writes.length

    await expect(wallet.resetWallet(PASSWORD)).resolves.toBeUndefined()

    expect(siteA).toHaveLength(told)
    expect(uiMessages).toHaveLength(announced)
    expect(disk.writes).toHaveLength(writes)
  })

  it('does nothing on a new install', async () => {
    disk = new Disk()
    await startServices()
    wallet = newController()
    await preferenceService.persist()
    const writes = disk.writes.length

    await expect(wallet.resetWallet(PASSWORD)).resolves.toBeUndefined()

    expect(disk.writes).toHaveLength(writes)
    expect(keyringService.isBooted()).toBe(false)
    expect(uiMethods()).toEqual([])
  })
})

describe('a reset offered as the removal of the last usable wallet', () => {
  /** The wallets as a page read them, which reach it as JSON. */
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))
  const NOT_LAST_WALLET = { code: ErrorCodes.WALLET_RESET_NOT_LAST_WALLET }

  it('erases the wallet the page named while it is still the only usable one', async () => {
    await createWallet()
    const [only] = await listed()

    await expect(
      viaUiPort('resetWallet', PASSWORD, { lastWalletKey: only.key })
    ).resolves.toBeUndefined()

    expect(keyringService.isBooted()).toBe(false)
    expect(await diskHoldsAWallet()).toBe(false)
    expect(uiMethods()).toContain(BUS_METHODS.WALLET_RESET)
  })

  it('erases, announces and records nothing when another window added a usable wallet after the page read its list', async () => {
    await createWallet()
    await permissionService.addConnectedSite(SITE_A, 'A', '', ChainType.QBIT_MAINNET)
    const [only] = await listed()
    // Another window adds a wallet while the page still lists one.
    await createWallet(OTHER_MNEMONIC)
    const siteA = openSitePage(SITE_A)
    uiMessages.length = 0
    const before = await erasableState()

    const refused = await viaUiPort('resetWallet', PASSWORD, { lastWalletKey: only.key }).catch(
      (error: unknown) => error
    )

    expect(refused).toMatchObject(NOT_LAST_WALLET)
    expect(await erasableState()).toEqual(before)
    expect(before.keyrings).toHaveLength(2)
    expect(wallet.isUnlocked()).toBe(true)
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(siteA).toEqual([])
    expect(uiMethods()).toEqual([])
  })

  it('refuses when the wallet the page named is gone', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const [, second] = await listed()
    // Another window removed it; the wallet left is usable.
    await wallet.removeKeyring(second)
    const before = await erasableState()

    for (const lastWalletKey of [second.key, 'keyring_9']) {
      await expect(viaUiPort('resetWallet', PASSWORD, { lastWalletKey })).rejects.toMatchObject(
        NOT_LAST_WALLET
      )
    }

    expect(await erasableState()).toEqual(before)
    expect(await diskHoldsAWallet()).toBe(true)
  })

  it('refuses, before anything is written, a wallet another window adds while the recovery risks are read', async () => {
    await createWallet()
    const [only] = await listed()
    const read = keyringService.getAllDisplayedKeyrings.bind(keyringService)
    let reads = 0
    vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementation(async (...args) => {
      reads += 1
      // The reset reads the wallets for its premise, then for the risks.
      if (reads === 2) await createWallet(OTHER_MNEMONIC)
      return read(...args)
    })
    const lock = vi.spyOn(keyringService, 'setLocked')

    await expect(
      viaUiPort('resetWallet', PASSWORD, { lastWalletKey: only.key })
    ).rejects.toMatchObject(NOT_LAST_WALLET)

    expect(lock).not.toHaveBeenCalled()
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect((await wallet.getKeyrings()).map(keyring => keyring.key)).toEqual([
      'keyring_0',
      'keyring_1',
    ])
    expect(await diskHoldsAWallet()).toBe(true)
    expect(uiMethods()).not.toContain(BUS_METHODS.WALLET_RESET)
  })

  it('checks the password, and that the wallet is unlocked, before the wallet the page named', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)

    await expect(
      viaUiPort('resetWallet', 'not the password', { lastWalletKey: 'keyring_0' })
    ).rejects.toThrow('password_error')
    await wallet.lockWallet()
    await expect(
      viaUiPort('resetWallet', PASSWORD, { lastWalletKey: 'keyring_0' })
    ).rejects.toThrow('you_need_to_unlock_wallet_first')
    expect(keyringService.isBooted()).toBe(true)
  })

  it.each([
    ['no options', undefined],
    ['options that name no wallet', {}],
    ['a last wallet left null', { lastWalletKey: null }],
  ])('erases every wallet, whatever their number, for a reset with %s', async (_label, options) => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)

    await expect(viaUiPort('resetWallet', PASSWORD, options)).resolves.toBeUndefined()

    expect(keyringService.isBooted()).toBe(false)
    expect(await diskHoldsAWallet()).toBe(false)
  })
})

describe('a reset and the chain-state queue', () => {
  it('waits for a queued change whose vault write is under way, and the vault never comes back', async () => {
    await createWallet()
    const [hd] = (await wallet.getKeyrings()) as any[]
    const write = disk.holdNextWrite(isVaultWrite)
    const deriving = wallet.deriveNewAccountFromMnemonic(hd)
    await write.started

    const resetting = wallet.resetWallet(PASSWORD)
    await sleep(20)
    // Nothing of the reset has run while the change ahead of it is unfinished.
    expect(wallet.isUnlocked()).toBe(true)
    expect(preferenceService.getWalletResetPending()).toBe(false)
    write.release()

    await expect(deriving).resolves.toBeDefined()
    await expect(resetting).resolves.toBeUndefined()
    expect(keyringService.isBooted()).toBe(false)
    expect(keyringService.hasVault()).toBe(false)
    expect(disk.read('keyringState')).toMatchObject({ booted: '', vault: null })
    expect(vaultWritesAfterErase()).toEqual([])
    expect(await diskHoldsAWallet()).toBe(false)
  })

  it('erases the vault only once a write whose encryption ends during the reset has ended', async () => {
    await createWallet()
    // A vault write that does not queue as a chain-state change, as a
    // signature counter or a receive address saves, encrypting when the reset starts.
    const save = encryptor.holdNextSave()
    const writing = keyringService.persistAllKeyrings([])
    await save.started
    const erase = disk.holdNextWrite(isEraseWrite)

    const resetting = wallet.resetWallet(PASSWORD)
    await vi.waitFor(() => expect(wallet.isUnlocked()).toBe(false))
    await sleep(20)
    // The encryption ends while the reset runs; the erase may be under way.
    save.release()
    await sleep(20)
    erase.release()

    await expect(writing).resolves.toBe(true)
    await expect(resetting).resolves.toBeUndefined()
    expect(keyringService.hasVault()).toBe(false)
    expect(vaultWritesAfterErase()).toEqual([])
    expect(disk.read('keyringState')).toMatchObject({ booted: '', vault: null })
    expect(await diskHoldsAWallet()).toBe(false)
  })

  it('runs an unlock and a boot asked for during the reset only after it, and never brings the old wallet back', async () => {
    await createWallet()
    const erase = disk.holdNextWrite(isEraseWrite)
    const resetting = wallet.resetWallet(PASSWORD)
    await erase.started
    const boot = vi.spyOn(keyringService, 'boot')
    const submit = vi.spyOn(keyringService, 'submitPassword')

    const unlocking = wallet.unlock(PASSWORD)
    const booting = wallet.boot(NEW_PASSWORD)
    await sleep(20)
    expect(boot).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    erase.release()

    await expect(resetting).resolves.toBeUndefined()
    await expect(unlocking).rejects.toThrow()
    await expect(booting).resolves.toBeUndefined()
    expect(boot).toHaveBeenCalledOnce()
    expect(keyringService.hasVault()).toBe(false)
    expect(await keyringService.verifyPassword(NEW_PASSWORD)).toBe(true)
    expect(await keyringService.verifyPassword(PASSWORD)).toBe(false)
    expect(vaultWritesAfterErase()).toEqual([])
    expect(disk.read('keyringState').vault).toBeNull()
  })
})

describe('a reset while a signing runs', () => {
  // A P2MR account and a two-input send of it, signed by a keyring stand-in
  // that, like the keyring, stops before its next input once told to, and
  // otherwise runs far longer than the test.
  const pubkeyHex = '11'.repeat(32)
  const leafScript = singleKeyLeafScript(hexToBytes(pubkeyHex))
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const accountScript = p2mrScriptPubKey(leafHash)
  const address = p2mrAddressFromPubkey(hexToBytes(pubkeyHex), 'mainnet')
  const account = {
    type: KeyringType.QbitHdKeyring,
    pubkey: pubkeyHex,
    address,
    key: 'keyring_0#0',
    flag: 0,
    index: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: `m/87'/0'/0'/0/0`,
      scriptPubKey: bytesToHex(accountScript),
      leafScript: bytesToHex(leafScript),
      addresses: { mainnet: address },
      hkdf: { account: 0, change: 0, index: 0 },
    },
  }

  function twoInputSend(): ToSignData {
    const psbt = createP2mrPsbt({
      inputs: [0, 1].map(vout => ({
        prevout: { txid: new Uint8Array(32).fill(9), vout },
        witnessUtxo: { value: 100_000n, scriptPubKey: accountScript },
        leafScript,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
        merkleRoot: leafHash,
      })),
      outputs: [{ value: 190_000n, scriptPubKey: accountScript }],
    })
    return {
      psbtHex: bytesToHex(serializePsbt(psbt)),
      toSignInputs: [0, 1].map(index => ({ index, publicKey: pubkeyHex })),
      qbitP2mrSigningKeys: [0, 1].map(inputIndex => ({
        inputIndex,
        publicKey: pubkeyHex,
        leafHash: bytesToHex(leafHash),
      })),
      autoFinalized: true,
    }
  }

  it('stops the signing and completes without waiting for it', async () => {
    await createWallet()
    preferenceService.setCurrentAccount(account as any)
    const started = deferred()
    vi.spyOn(keyringService, 'signP2mrPsbtWithCounter').mockImplementation(
      (_address, _request, _budget, _batch, options) =>
        new Promise((_resolve, reject) => {
          started.resolve()
          options?.signal?.addEventListener('abort', () => reject(new QbitSigningAbortedError()))
        })
    )
    const signing = wallet.runForUiPort(
      'popup:1',
      () => wallet.signPsbtV2(twoInputSend()),
      'signPsbtV2'
    )
    const signed = signing.then(
      () => 'signed',
      (error: unknown) => error
    )
    await started.promise

    const outcome = await Promise.race([
      wallet.resetWallet(PASSWORD).then(() => 'reset'),
      sleep(3_000).then(() => 'still waiting for the signing'),
    ])

    expect(outcome).toBe('reset')
    expect(await signed).toBeInstanceOf(QbitSigningAbortedError)
    expect(internals().localSignings.size).toBe(0)
    expect(keyringService.isBooted()).toBe(false)
  })

  it('lets a batch entry already let through sign for its page while a reset that erases nothing begins', async () => {
    await createWallet()
    preferenceService.setCurrentAccount(account as any)
    const chain = wallet.getChainType()
    const reading = deferred()
    const read = deferred()
    vi.spyOn(wallet as any, 'readQbitPsbtReviewContext').mockImplementation(async () => {
      reading.resolve()
      await read.promise
      return { account, chain }
    })
    vi.spyOn(wallet as any, 'analyzeLocalQbitPsbts').mockReturnValue({
      items: [{ parseError: false, risks: [] }],
    })
    // The entry's signing proper, with the port it signs for.
    const signedFor: unknown[] = []
    vi.spyOn(wallet, 'signPsbtV2').mockImplementation(async () => {
      signedFor.push((wallet as any).callingUiPort)
      return { psbtHex: 'signed' } as any
    })
    const entry = viaPort('tab:5', 'signLocalBatchPsbt', twoInputSend(), {
      account: address,
      chain,
      confirmedRisks: [],
    })
    await reading.promise

    // Another window's reset begins during the entry's review read, and is
    // held at its password check, which it then fails.
    const checking = deferred()
    const answer = deferred()
    const verify = keyringService.verifyPassword.bind(keyringService)
    vi.spyOn(keyringService, 'verifyPassword').mockImplementationOnce(async password => {
      checking.resolve()
      await answer.promise
      return verify(password)
    })
    const resetting = viaUiPort('resetWallet', 'not the password').catch((error: unknown) => error)
    await checking.promise
    read.resolve()

    const outcome = await Promise.race([
      entry.then(
        () => 'signed',
        (error: unknown) => error
      ),
      sleep(1_000).then(() => 'held by the reset'),
    ])
    answer.resolve()

    expect(outcome).toBe('signed')
    expect(signedFor).toEqual(['tab:5'])
    expect(await resetting).toMatchObject({ message: 'password_error' })
  })
})

describe('a reset that fails after the keys are erased', () => {
  /** Fails the next `times` writes of the biometric record: the keyring's reset hook writes it first. */
  const failBiometricClears = (times: number) => disk.failWrites(isBiometricWrite, times)

  async function incompleteReset() {
    await seedWalletData()
    const siteA = openSitePage(SITE_A)
    // The keyring's own reset hook and the clear after the keys both fail.
    failBiometricClears(2)
    const error = await wallet.resetWallet(PASSWORD).catch((failure: unknown) => failure)
    return { error, siteA }
  }

  /** Nothing of the old wallets is left beside the language and the theme. */
  async function expectNothingLeft() {
    expect(preferenceService.getKeyringAlianName('keyring_1')).toBe('')
    expect(preferenceService.getKeyringColor('keyring_1')).toBeUndefined()
    expect(preferenceService.getAccountAlianName('keyring_0#0')).toBe('')
    expect(preferenceService.getCurrentAccount()).toBeNull()
    expect(permissionService.getConnectedSites()).toEqual([])
    expect(contactBookService.listContacts()).toEqual([])
    expect(await biometricUnlockService.getStatus()).toEqual({ enrolled: false })
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(preferenceService.getLocale()).toBe('fr')
    expect(preferenceService.getThemeMode()).toBe('dark')
    const stored = disk.read('preference')
    expect(stored.keyringAlianNames).toEqual({})
    expect(stored.keyringColors).toEqual({})
    expect(stored.accountAlianNames).toEqual({})
    expect(stored).not.toHaveProperty('currentAccount')
    expect(stored).not.toHaveProperty('walletResetPending')
  }

  it('rejects as incomplete, still announces the reset, and leaves it pending', async () => {
    const { error, siteA } = await incompleteReset()

    expect(error).toMatchObject({ code: ErrorCodes.WALLET_RESET_INCOMPLETE })
    expect(keyringService.isBooted()).toBe(false)
    expect(keyringService.hasVault()).toBe(false)
    expect(siteA).toEqual([
      [SESSION_EVENTS.accountsChanged, []],
      [SESSION_EVENTS.disconnect, expect.objectContaining({ code: 4900 })],
    ])
    expect(uiMethods().filter(method => method === BUS_METHODS.WALLET_RESET)).toHaveLength(1)
    expect(uiMethods()).not.toContain(BUS_METHODS.LOCKED)
    // A biometric record whose clear failed is not reported as cleared.
    expect(await biometricUnlockService.getStatus()).toEqual({ enrolled: true })
    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(disk.read('preference').walletResetPending).toBe(true)
  })

  it('is finished by the next reset, whatever its password, with no second announcement', async () => {
    await incompleteReset()
    const announced = uiMessages.length

    await expect(wallet.resetWallet('not the password')).resolves.toBeUndefined()

    await expectNothingLeft()
    expect(uiMessages).toHaveLength(announced)
  })

  it('refuses an empty password even when nothing but the clearing is left to do', async () => {
    await incompleteReset()

    await expect(viaUiPort('resetWallet', '')).rejects.toThrow('password_error')

    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(preferenceService.getKeyringAlianName('keyring_1')).toBe('Savings')
  })

  it('is finished by the next reset however it names the last wallet, as no wallet is left', async () => {
    await incompleteReset()

    await expect(
      viaUiPort('resetWallet', 'not the password', { lastWalletKey: 'keyring_0' })
    ).resolves.toBeUndefined()

    await expectNothingLeft()
  })

  it('is finished by boot before the new password is set, so the new wallet inherits nothing', async () => {
    const { siteA } = await incompleteReset()
    const told = siteA.length
    const announced = uiMessages.length

    await wallet.boot(NEW_PASSWORD)
    await expectNothingLeft()
    // The page asking is on the first-run screen: nothing is announced.
    expect(uiMessages).toHaveLength(announced)
    expect(siteA).toHaveLength(told)
    await createWallet()

    const [created] = (await wallet.getKeyrings()) as any[]
    expect(created.alianName).toBe('Wallet 1')
    expect(created.accounts[0].alianName).toBe('Account 1')
    expect(preferenceService.getCurrentAccount()?.pubkey).toBe(created.accounts[0].pubkey)
    expect(permissionService.getConnectedSites()).toEqual([])
    expect(contactBookService.listContacts()).toEqual([])
    expect(await biometricUnlockService.getStatus()).toEqual({ enrolled: false })
  })

  it('makes boot refuse, setting no password, while it still cannot be finished', async () => {
    await incompleteReset()
    // The keyring's erase, made again first, clears the record in its hook,
    // which swallows a failure; the clear after it fails too.
    failBiometricClears(2)

    await expect(wallet.boot(NEW_PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })

    expect(keyringService.isBooted()).toBe(false)
    expect(preferenceService.getWalletResetPending()).toBe(true)
    // Once it can, it is finished and boot goes on.
    await wallet.boot(NEW_PASSWORD)
    await expectNothingLeft()
    expect(await keyringService.verifyPassword(NEW_PASSWORD)).toBe(true)
  })

  it('is finished when the background starts again', async () => {
    await incompleteReset()

    // The worker restarts: every service loads what is on the disk.
    await startServices()
    wallet = newController()
    expect(preferenceService.getWalletResetPending()).toBe(true)

    await expect(wallet.finishPendingWalletReset()).resolves.toBe(true)

    await expectNothingLeft()
    await expect(wallet.finishPendingWalletReset()).resolves.toBe(false)
  })
})

describe('a reset that cannot record that it is pending', () => {
  it('erases nothing, stops and locks nothing, and announces nothing', async () => {
    await seedWalletData()
    const siteA = openSitePage(SITE_A)
    disk.failWrites((key, value) => key === 'preference' && value?.walletResetPending === true, 1)
    const before = await erasableState()
    const lock = vi.spyOn(keyringService, 'setLocked')

    await expect(wallet.resetWallet(PASSWORD)).rejects.toThrow('disk full')

    expect(await erasableState()).toEqual(before)
    expect(lock).not.toHaveBeenCalled()
    expect(wallet.isUnlocked()).toBe(true)
    expect(siteA).toEqual([])
    expect(uiMethods()).toEqual([])
  })
})

describe('a change of the password or the biometric unlock asked for during a reset', () => {
  it('is held by the port until the reset ends, refused as the reset erased the wallet, and cannot bring the old vault back', async () => {
    await createWallet()
    const erase = disk.holdNextWrite(isEraseWrite)
    const resetting = wallet.resetWallet(PASSWORD)
    await erase.started

    const changing = viaUiPort('changePassword', PASSWORD, NEW_PASSWORD).then(
      () => 'changed',
      (error: Error) => error.message
    )
    const enrolling = viaUiPort('saveBiometricUnlockRecord', BIOMETRIC_RECORD, PASSWORD).then(
      () => 'enrolled',
      (error: Error) => error.message
    )
    await sleep(20)
    erase.release()

    await expect(resetting).resolves.toBeUndefined()
    expect(await changing).toBe(CALL_REFUSED)
    expect(await enrolling).toBe(CALL_REFUSED)
    expect(keyringService.isBooted()).toBe(false)
    expect(vaultWritesAfterErase()).toEqual([])
    expect(await diskHoldsAWallet()).toBe(false)
    expect(disk.read('biometricUnlock')).toBeNull()
  })

  it('goes ahead at once when no reset runs', async () => {
    await createWallet()

    await viaUiPort('changePassword', PASSWORD, NEW_PASSWORD)

    expect(await keyringService.verifyPassword(NEW_PASSWORD)).toBe(true)
  })
})

describe('a read of the addresses by type asked for during a reset', () => {
  it("is held by the port until the reset ends, so the erased wallet's public keys are not saved back for its slot", async () => {
    await createWallet()
    const [hd] = (await wallet.getKeyrings()) as any[]
    // The keyring service keeps these public keys by slot, and saves them
    // again on every read.
    await wallet.getAllAddresses(hd, 0)
    expect(disk.read('cached_pubkeys')).not.toBeNull()
    const erase = disk.holdNextWrite(isEraseWrite)
    const resetting = wallet.resetWallet(PASSWORD)
    await erase.started
    const savedBack = disk.holdNextWrite((key, value) => key === 'cached_pubkeys' && value !== null)

    const reading = viaUiPort('getAllAddresses', hd, 0).then(
      () => 'read',
      (error: Error) => error.message
    )
    await sleep(20)
    erase.release()
    await resetting
    savedBack.release()

    expect(await reading).toBe(CALL_REFUSED)
    expect(disk.read('cached_pubkeys')).toBeNull()
  })
})

describe('a reset whose keyring step fails', () => {
  it.each([
    ['the erased store', isEraseWrite],
    ['the erased public key cache', isPubkeyCacheErase],
  ])(
    'goes on as a reset when a write of %s fails once and the next try succeeds',
    async (_label, write) => {
      await seedWalletData()
      const siteA = openSitePage(SITE_A)
      disk.failWrites(write, 1)

      await expect(wallet.resetWallet(PASSWORD)).resolves.toBeUndefined()

      expect(keyringService.isBooted()).toBe(false)
      expect(await diskHoldsAWallet()).toBe(false)
      expect(disk.read('cached_pubkeys')).toBeNull()
      expect(preferenceService.getWalletResetPending()).toBe(false)
      expect(uiMethods().filter(method => method === BUS_METHODS.WALLET_RESET)).toHaveLength(1)
      expect(uiMethods()).not.toContain(BUS_METHODS.LOCKED)
      expect(siteA).toEqual([
        [SESSION_EVENTS.accountsChanged, []],
        [SESSION_EVENTS.disconnect, expect.objectContaining({ code: 4900 })],
      ])
    }
  )

  /** The public key cache cannot be erased however often it is tried: the vault erase landed, memory kept it. */
  async function unknownOutcome() {
    await seedWalletData()
    const siteA = openSitePage(SITE_A)
    disk.failWrites(isPubkeyCacheErase, 99)
    const error = await wallet.resetWallet(PASSWORD).catch((failure: unknown) => failure)
    return { error, siteA }
  }

  it('rejects as of unknown outcome once the tries run out: locked and said so, no reset announced, the mark kept', async () => {
    const { error, siteA } = await unknownOutcome()

    expect(error).toMatchObject({ code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN })
    // Storage holds no wallet any more, memory still does.
    expect(await diskHoldsAWallet()).toBe(false)
    expect(keyringService.isBooted()).toBe(true)
    expect(keyringService.hasVault()).toBe(true)
    expect(wallet.isUnlocked()).toBe(false)
    expect(uiMethods()).toEqual([BUS_METHODS.LOCKED])
    expect(siteA).toEqual([[SESSION_EVENTS.lock, undefined]])
    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(disk.read('preference').walletResetPending).toBe(true)
    // Nothing after the keys was cleared.
    expect(
      permissionService
        .getConnectedSites()
        .map(site => site.origin)
        .sort()
    ).toEqual([SITE_A, SITE_B])
    expect(contactBookService.listContacts()).toHaveLength(1)
  })

  it('is finished when the background starts again, which tells each site that still held a grant and every page, once', async () => {
    await unknownOutcome()
    disk.stopFailing()

    // The worker restarts: every service loads what is on the disk.
    await startServices()
    wallet = newController()
    const siteA = openSitePage(SITE_A)
    const siteB = openSitePage(SITE_B)
    uiMessages.length = 0
    expect(keyringService.isBooted()).toBe(false)

    await expect(wallet.finishPendingWalletReset()).resolves.toBe(true)

    for (const told of [siteA, siteB]) {
      expect(told).toEqual([
        [SESSION_EVENTS.accountsChanged, []],
        [SESSION_EVENTS.disconnect, expect.objectContaining({ code: 4900 })],
      ])
    }
    expect(uiMessages.filter(message => message.method === BUS_METHODS.WALLET_RESET)).toEqual([
      { method: BUS_METHODS.WALLET_RESET, params: {} },
    ])
    expect(permissionService.getConnectedSites()).toEqual([])
    expect(contactBookService.listContacts()).toEqual([])
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(preferenceService.getKeyringAlianName('keyring_1')).toBe('')
  })

  it('refuses an unlock with the password until the background starts again, writing nothing to the stored keys', async () => {
    await unknownOutcome()
    disk.stopFailing()
    const writesAtOutcome = disk.writes.length

    await expect(viaUiPort('unlock', PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })

    expect(wallet.isUnlocked()).toBe(false)
    expect(disk.writes.slice(writesAtOutcome).map(write => write.key)).not.toContain('keyringState')
    expect(await diskHoldsAWallet()).toBe(false)
  })

  it('refuses an unlock from a biometric prompt the same way, and keeps the record for the next start', async () => {
    await unknownOutcome()
    disk.stopFailing()
    const writesAtOutcome = disk.writes.length

    // The page reads the wrapped record, unwraps the password itself and
    // ends in the same unlock call.
    expect(await viaUiPort('getBiometricUnlockRecord')).toEqual(BIOMETRIC_RECORD)
    await expect(viaUiPort('unlock', PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })

    // The refusal neither erased the record nor wrote any stored state.
    expect(await viaUiPort('getBiometricUnlockRecord')).toEqual(BIOMETRIC_RECORD)
    expect(disk.read('biometricUnlock')).toEqual(BIOMETRIC_RECORD)
    expect(disk.writes.slice(writesAtOutcome).map(write => write.key)).toEqual([])
    expect(wallet.isUnlocked()).toBe(false)
  })

  it('refuses another reset with that outcome too, rather than for the lock no unlock may lift', async () => {
    await unknownOutcome()
    disk.stopFailing()
    const writesAtOutcome = disk.writes.length

    await expect(viaUiPort('resetWallet', PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })

    expect(disk.writes.slice(writesAtOutcome)).toEqual([])
    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(keyringService.hasVault()).toBe(true)
  })

  it('lets a wallet be set up again once a completion finds the keys gone', async () => {
    await unknownOutcome()
    disk.stopFailing()
    // The keyring's erase finished straight on the keyring, standing in for
    // what nothing in the background can do after that outcome: memory now
    // holds no wallet either.
    await keyringService.resetAllData()

    // A reset finds nothing booted and finishes the first one.
    await expect(viaUiPort('resetWallet', PASSWORD)).resolves.toBeUndefined()

    await expect(viaUiPort('boot', NEW_PASSWORD)).resolves.toBeUndefined()
    await createWallet()
    expect(wallet.isUnlocked()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
  })

  it('refuses a change of the password and a boot until the background starts again, writing nothing to the stored keys', async () => {
    await unknownOutcome()
    disk.stopFailing()
    const writesAtOutcome = disk.writes.length

    await expect(viaUiPort('changePassword', PASSWORD, NEW_PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })
    await expect(viaUiPort('boot', NEW_PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })

    // Memory still holds the vault, and storage none.
    expect(keyringService.hasVault()).toBe(true)
    expect(disk.writes.slice(writesAtOutcome).map(write => write.key)).not.toContain('keyringState')
    expect(await diskHoldsAWallet()).toBe(false)
    // Reads go on as before.
    await expect(viaUiPort('isBooted')).resolves.toBe(true)
    await expect(viaUiPort('verifyPassword', PASSWORD)).resolves.toBe(true)
  })

  it('is found intact when the background starts again and the erase never reached storage: the old password unlocks it, nothing lost', async () => {
    await seedWalletData()
    disk.failWrites(isEraseWrite, 99)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })
    disk.stopFailing()
    expect(await diskHoldsAWallet()).toBe(true)

    // The worker restarts: every service loads what is on the disk.
    await startServices()
    wallet = newController()
    uiMessages.length = 0

    await expect(wallet.finishPendingWalletReset()).resolves.toBe(false)
    // Beside the wallet storage holds, the mark is known to be stale.
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(disk.read('preference').walletResetPending).toBeUndefined()
    await wallet.unlock(PASSWORD)
    expect((await wallet.getKeyrings()).map(keyring => keyring.key)).toEqual([
      'keyring_0',
      'keyring_1',
    ])
    expect(
      permissionService
        .getConnectedSites()
        .map(site => site.origin)
        .sort()
    ).toEqual([SITE_A, SITE_B])
    expect(contactBookService.listContacts()).toHaveLength(1)
    expect(preferenceService.getKeyringAlianName('keyring_1')).toBe('Savings')
    expect(await biometricUnlockService.getRecord()).toEqual(BIOMETRIC_RECORD)
    expect(uiMethods()).not.toContain(BUS_METHODS.WALLET_RESET)
    // A reset with the password erases it, as any other.
    await wallet.resetWallet(PASSWORD)
    expect(await diskHoldsAWallet()).toBe(false)
  })

  it('keeps a stale mark it cannot forget as the background starts beside a wallet, and still erases nothing', async () => {
    await seedWalletData()
    // A mark beside the wallet storage holds, as a reset whose erase never
    // reached storage leaves one.
    await preferenceService.setWalletResetPending()
    await startServices()
    wallet = newController()
    uiMessages.length = 0
    disk.failWrites(
      (key, value) => key === 'preference' && value?.walletResetPending === undefined,
      1
    )

    await expect(wallet.finishPendingWalletReset()).resolves.toBe(false)

    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(disk.read('preference').walletResetPending).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
    expect(
      permissionService
        .getConnectedSites()
        .map(site => site.origin)
        .sort()
    ).toEqual([SITE_A, SITE_B])
    expect(contactBookService.listContacts()).toHaveLength(1)
    expect(uiMethods()).not.toContain(BUS_METHODS.WALLET_RESET)
    await wallet.unlock(PASSWORD)
    expect(keyringService.keyrings).toHaveLength(2)
  })

  it('takes back only the mark it set: one the start could not forget stays when a reset then fails at its lock', async () => {
    await seedWalletData()
    await preferenceService.setWalletResetPending()
    await startServices()
    wallet = newController()
    disk.failWrites(
      (key, value) => key === 'preference' && value?.walletResetPending === undefined,
      1
    )
    await expect(wallet.finishPendingWalletReset()).resolves.toBe(false)
    await wallet.unlock(PASSWORD)
    vi.spyOn(keyringService, 'setLocked').mockRejectedValueOnce(new Error('lock failed'))

    await expect(wallet.resetWallet(PASSWORD)).rejects.toThrow('lock failed')

    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(disk.read('preference').walletResetPending).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
  })

  it('keeps that mark when the wallet is unlocked straight on the keyring and reset again, so the next start still finishes the first', async () => {
    await unknownOutcome()
    disk.stopFailing()
    // Unlocked again from memory, as by a route the refusal above did not
    // know of, and a reset asked for again: refused before it writes.
    await keyringService.submitPassword(PASSWORD)

    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })

    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(disk.read('preference').walletResetPending).toBe(true)
    await startServices()
    wallet = newController()
    uiMessages.length = 0
    await expect(wallet.finishPendingWalletReset()).resolves.toBe(true)
    expect(permissionService.getConnectedSites()).toEqual([])
    expect(contactBookService.listContacts()).toEqual([])
    expect(preferenceService.getKeyringAlianName('keyring_1')).toBe('')
    expect(uiMethods()).toContain(BUS_METHODS.WALLET_RESET)
  })

  it('rejects as of unknown outcome, announcing no reset, when the vault is back in memory after the erase', async () => {
    await seedWalletData()
    const siteA = openSitePage(SITE_A)
    const { booted, vault } = keyringService.store.getState()
    const erase = keyringService.resetAllData
    vi.spyOn(keyringService, 'resetAllData').mockImplementation(async () => {
      await erase()
      // Something the reset does not hold off saves the wallet again.
      keyringService.store.updateState({ booted, vault })
    })

    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })

    expect(uiMethods()).toEqual([BUS_METHODS.LOCKED])
    expect(siteA).toEqual([[SESSION_EVENTS.lock, undefined]])
    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(permissionService.getConnectedSites()).toHaveLength(2)
  })
})

describe("a wallet page's call made while a reset runs", () => {
  const REFUSED = CALL_REFUSED
  /** The reset's write of the preferences, last of its steps. */
  const isPreferenceReset: WriteMatch = (key, value) =>
    key === 'preference' &&
    value?.walletResetPending === undefined &&
    JSON.stringify(value?.keyringAlianNames) === '{}'
  const BOB = { name: 'Bob', address: 'qb1zbob', chain: ChainType.QBIT_MAINNET, isContact: true }

  it('waits for the reset, and is refused once the reset erased the wallet: no contact reaches the next wallet', async () => {
    await seedWalletData()
    const preferencesReset = disk.holdNextWrite(isPreferenceReset)
    const resetting = wallet.resetWallet(PASSWORD)
    await preferencesReset.started

    const adding = viaUiPort('addContact', BOB).then(
      () => 'added',
      (error: Error) => error.message
    )
    await sleep(20)
    preferencesReset.release()

    await expect(resetting).resolves.toBeUndefined()
    expect(await adding).toBe(REFUSED)
    expect(contactBookService.listContacts()).toEqual([])
    expect(disk.read('contactBook')).toEqual({})
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    expect(contactBookService.listContacts()).toEqual([])
  })

  it('holds a call that names no method like any other: only the methods let through by name run', async () => {
    await seedWalletData()
    const preferencesReset = disk.holdNextWrite(isPreferenceReset)
    const resetting = wallet.resetWallet(PASSWORD)
    await preferencesReset.started

    // Only a caller the types do not check can leave the method out.
    const runUnnamed = wallet.runForUiPort as (port: string, call: () => unknown) => unknown
    const adding = Promise.resolve()
      .then(() => runUnnamed('popup:1', () => getUiControllerMethod(wallet, 'addContact')(BOB)))
      .then(
        () => 'added',
        (error: Error) => error.message
      )
    await sleep(20)
    preferencesReset.release()

    await expect(resetting).resolves.toBeUndefined()
    expect(await adding).toBe(REFUSED)
    expect(contactBookService.listContacts()).toEqual([])
  })

  it('refuses a change of language made during the reset, so the pages, the background and the store agree', async () => {
    await seedWalletData()
    const changeLanguage = vi.spyOn(bgI18n, 'changeLanguage')
    const preferencesReset = disk.holdNextWrite(isPreferenceReset)
    const resetting = wallet.resetWallet(PASSWORD)
    await preferencesReset.started

    const setting = viaUiPort('setLocale', 'ja').then(
      () => 'set',
      (error: Error) => error.message
    )
    await sleep(20)
    preferencesReset.release()

    await expect(resetting).resolves.toBeUndefined()
    expect(await setting).toBe(REFUSED)
    expect(changeLanguage).not.toHaveBeenCalled()
    expect(uiMethods()).not.toContain(BUS_METHODS.LOCALE_CHANGED)
    expect(preferenceService.getLocale()).toBe('fr')
    await preferenceService.persist()
    expect(disk.read('preference').locale).toBe('fr')
  })

  it('runs once a reset that erased nothing is over', async () => {
    await seedWalletData()
    const checking = deferred()
    const verify = keyringService.verifyPassword
    vi.spyOn(keyringService, 'verifyPassword').mockImplementationOnce(async password => {
      await checking.promise
      return verify(password)
    })
    const resetting = wallet.resetWallet('not the password').catch((error: Error) => error.message)
    await sleep(10)

    const adding = viaUiPort('addContact', BOB).then(
      () => 'added',
      (error: Error) => error.message
    )
    await sleep(20)
    expect(contactBookService.listContacts().map(contact => contact.name)).toEqual(['Alice'])
    checking.resolve()

    expect(await resetting).toBe('password_error')
    expect(await adding).toBe('added')
    expect(
      contactBookService
        .listContacts()
        .map(contact => contact.name)
        .sort()
    ).toEqual(['Alice', 'Bob'])
  })

  it('runs as usual once the reset is over', async () => {
    await seedWalletData()
    await wallet.resetWallet(PASSWORD)

    await expect(viaUiPort('setThemeMode', 'light')).resolves.toBeUndefined()

    expect(preferenceService.getThemeMode()).toBe('light')
  })

  it('lets a second reset through, which then finds nothing left to do', async () => {
    await seedWalletData()
    const erase = disk.holdNextWrite(isEraseWrite)
    const first = viaUiPort('resetWallet', PASSWORD)
    await erase.started

    const second = viaUiPort('resetWallet', PASSWORD)
    erase.release()

    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(uiMethods().filter(method => method === BUS_METHODS.WALLET_RESET)).toHaveLength(1)
  })
})

describe('a read of the addresses by type under way when a reset begins', () => {
  it('ends before the keys are erased, so it cannot save the erased public keys back', async () => {
    await createWallet()
    const [hd] = (await wallet.getKeyrings()) as any[]
    await wallet.getAllAddresses(hd, 0)
    const savedBack = disk.holdNextWrite((key, value) => key === 'cached_pubkeys' && value !== null)
    const reading = wallet.getAllAddresses(hd, 0)
    await savedBack.started

    const resetting = wallet.resetWallet(PASSWORD)
    await sleep(20)
    // The reset waits for the read before it erases anything.
    expect(disk.writes.some(write => isEraseWrite(write.key, write.value))).toBe(false)
    savedBack.release()

    await reading
    await expect(resetting).resolves.toBeUndefined()
    expect(disk.read('cached_pubkeys')).toBeNull()
  })
})

describe('a reset and what changes around it', () => {
  it('refuses, erasing nothing, when another window locks the wallet while the risks are read', async () => {
    await createWallet()
    const read = keyringService.getAllDisplayedKeyrings.bind(keyringService)
    const risksRead = deferred()
    let reads = 0
    vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementation(async (...args) => {
      reads += 1
      const displayed = await read(...args)
      // The first read of the reset is that of the recovery risks.
      if (reads === 1) await risksRead.promise
      return displayed
    })
    const resetting = wallet.resetWallet(PASSWORD)
    await vi.waitFor(() => expect(reads).toBe(1))

    await wallet.lockWallet()
    risksRead.resolve()

    await expect(resetting).rejects.toThrow('you_need_to_unlock_wallet_first')
    expect(keyringService.isBooted()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
    expect(preferenceService.getWalletResetPending()).toBe(false)
  })

  it('tells a site whose Connect lands while the keys are erased, as it clears its grant', async () => {
    await createWallet()
    const erase = disk.holdNextWrite(isEraseWrite)
    const resetting = wallet.resetWallet(PASSWORD)
    await erase.started
    // A Connect approved before the reset began gets its grant now.
    await permissionService.addConnectedSite(SITE_A, 'A', '', ChainType.QBIT_MAINNET)
    const siteA = openSitePage(SITE_A)
    erase.release()

    await expect(resetting).resolves.toBeUndefined()

    expect(siteA).toEqual([
      [SESSION_EVENTS.accountsChanged, []],
      [SESSION_EVENTS.disconnect, expect.objectContaining({ code: 4900 })],
    ])
    expect(permissionService.getConnectedSites()).toEqual([])
  })

  it('drops the API clients bound to the local regtest service, and keeps the others', async () => {
    await createWallet()
    const clients = () => [...(wallet as any).qbitApiClients.keys()] as string[]
    ;(wallet as any).getQbitApiClient(ChainType.QBIT_REGTEST)
    ;(wallet as any).getQbitApiClient(ChainType.QBIT_MAINNET)
    expect(clients().some(key => key.startsWith(`${ChainType.QBIT_REGTEST}:`))).toBe(true)

    await wallet.resetWallet(PASSWORD)

    expect(clients().some(key => key.startsWith(`${ChainType.QBIT_REGTEST}:`))).toBe(false)
    expect(clients().some(key => key.startsWith(`${ChainType.QBIT_MAINNET}:`))).toBe(true)
  })
})

describe('a reset finished after its erase of the public key cache kept failing', () => {
  /** -21 with the store erased on disk and the cache, kept by slot, still there. */
  async function cacheLeftBehind() {
    await createWallet()
    const [old] = (await wallet.getKeyrings()) as any[]
    const oldAddresses = await wallet.getAllAddresses(old, 0)
    disk.failWrites(isPubkeyCacheErase, 99)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })
    expect(disk.read('cached_pubkeys')).not.toBeNull()
    disk.stopFailing()
    // The worker restarts: every service loads what is on the disk.
    await startServices()
    wallet = newController()
    return oldAddresses
  }

  it.each([
    ['the background starts again', () => wallet.finishPendingWalletReset()],
    ['boot sets the next password', () => wallet.boot(NEW_PASSWORD)],
    ['the next reset is asked for', () => wallet.resetWallet('not the password')],
  ])(
    'erases that cache too when %s, so the next wallet in slot 0 is not shown the erased addresses',
    async (_label, finish) => {
      const oldAddresses = await cacheLeftBehind()

      await finish()

      expect(disk.read('cached_pubkeys')).toBeNull()
      expect(preferenceService.getWalletResetPending()).toBe(false)
      if (!keyringService.isBooted()) await wallet.boot(NEW_PASSWORD)
      await createWallet(OTHER_MNEMONIC)
      const [created] = (await wallet.getKeyrings()) as any[]
      expect(created.index).toBe(0)
      const addresses = await wallet.getAllAddresses(created, 0)
      expect(addresses).not.toEqual(oldAddresses)
      expect(addresses).toContain(created.accounts[0].address)
    }
  )

  it('never runs the keyring erase beside a wallet that is kept, a stale mark notwithstanding', async () => {
    await createWallet()
    // The mark a reset whose keyring step failed leaves beside the wallet.
    await preferenceService.setWalletResetPending()
    const erase = vi.spyOn(keyringService, 'resetAllData')

    await expect(wallet.finishPendingWalletReset()).resolves.toBe(false)
    // The step itself checks again, right before it erases.
    await expect((wallet as any).finishKeyringErase()).rejects.toThrow('A wallet is kept again')

    expect(erase).not.toHaveBeenCalled()
    expect(keyringService.hasVault()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
  })
})

describe('a last-wallet reset and a wallet addition already under way', () => {
  const listed = async (): Promise<any[]> => JSON.parse(JSON.stringify(await wallet.getKeyrings()))

  /** Another window imports a wallet, held inside the keyring's addition before the wallet is added. */
  function holdImport() {
    const reached = deferred()
    const released = deferred()
    const check = keyringService.checkForDuplicate
    vi.spyOn(keyringService, 'checkForDuplicate').mockImplementationOnce(async (...args) => {
      reached.resolve()
      await released.promise
      return check(...args)
    })
    const importing = viaUiPort(
      'createKeyringWithMnemonics',
      OTHER_MNEMONIC,
      HD_PATH,
      '',
      AddressType.P2WPKH,
      1
    )
    return { importing, reached: reached.promise, release: released.resolve }
  }

  async function expectBothWalletsKept() {
    expect((await wallet.getKeyrings()).map(keyring => keyring.key)).toEqual([
      'keyring_0',
      'keyring_1',
    ])
    expect(wallet.isUnlocked()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(uiMethods()).not.toContain(BUS_METHODS.WALLET_RESET)
  }

  it('waits for the addition, then refuses as another usable wallet exists, erasing nothing', async () => {
    await createWallet()
    const [only] = await listed()
    const addition = holdImport()
    await addition.reached

    const resetting = viaUiPort('resetWallet', PASSWORD, { lastWalletKey: only.key }).catch(
      (error: unknown) => error
    )
    await sleep(20)
    // The reset has judged nothing yet, and written nothing.
    expect(preferenceService.getWalletResetPending()).toBe(false)
    addition.release()

    await expect(addition.importing).resolves.toBeUndefined()
    expect(await resetting).toMatchObject({ code: ErrorCodes.WALLET_RESET_NOT_LAST_WALLET })
    await expectBothWalletsKept()
  })

  it('refuses when the addition would land while the reset records that it is pending', async () => {
    await createWallet()
    const [only] = await listed()
    const marking = disk.holdNextWrite(
      (key, value) => key === 'preference' && value?.walletResetPending === true
    )
    const resetting = viaUiPort('resetWallet', PASSWORD, { lastWalletKey: only.key }).catch(
      (error: unknown) => error
    )
    await marking.started
    // The port holds a page's addition until the reset ends, so only a call
    // that does not come through it can start one now; it is held inside
    // the keyring's addition, so the wallet has not landed when the mark has.
    const reached = deferred()
    const released = deferred()
    const check = keyringService.checkForDuplicate
    vi.spyOn(keyringService, 'checkForDuplicate').mockImplementationOnce(async (...args) => {
      reached.resolve()
      await released.promise
      return check(...args)
    })
    const importing = wallet.createKeyringWithMnemonics(
      OTHER_MNEMONIC,
      HD_PATH,
      '',
      AddressType.P2WPKH,
      1
    )
    await reached.promise
    marking.release()

    expect(await resetting).toMatchObject({ code: ErrorCodes.WALLET_RESET_NOT_LAST_WALLET })
    released.resolve()
    await expect(importing).resolves.toBeUndefined()
    await expectBothWalletsKept()
    expect(disk.read('preference').walletResetPending).toBeUndefined()
  })

  it('judges again right before the lock, refusing a wallet the keyring added while the mark was written', async () => {
    await createWallet()
    const [only] = await listed()
    const marking = disk.holdNextWrite(
      (key, value) => key === 'preference' && value?.walletResetPending === true
    )
    const resetting = viaUiPort('resetWallet', PASSWORD, { lastWalletKey: only.key }).catch(
      (error: unknown) => error
    )
    await marking.started
    // An addition no page made, which no tracking sees, lands meanwhile.
    await keyringService.createKeyringWithMnemonics(
      OTHER_MNEMONIC,
      HD_PATH,
      '',
      AddressType.P2WPKH,
      1
    )
    marking.release()

    expect(await resetting).toMatchObject({ code: ErrorCodes.WALLET_RESET_NOT_LAST_WALLET })
    expect(keyringService.keyrings).toHaveLength(2)
    expect(wallet.isUnlocked()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
    // The mark it wrote is taken back.
    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(disk.read('preference').walletResetPending).toBeUndefined()
  })

  it('makes a reset that names no wallet wait for it too, so the next vault holds nothing from before the reset', async () => {
    await createWallet()
    const addition = holdImport()
    await addition.reached

    // A reset from Settings, then, as the first-run screen does, a new
    // password and a new wallet.
    const resetting = viaUiPort('resetWallet', PASSWORD)
    let resetEnded = false
    resetting.then(
      () => (resetEnded = true),
      () => (resetEnded = true)
    )
    // Queued behind the reset, which the port hands on a tick later.
    await sleep(0)
    const settingUp = wallet.boot(NEW_PASSWORD).then(() => createWallet())
    await sleep(50)
    // The reset does not end while the addition is under way.
    expect(resetEnded).toBe(false)
    addition.release()

    await addition.importing.catch(() => undefined)
    await expect(resetting).resolves.toBeUndefined()
    await settingUp
    // Only the new wallet, in memory and on disk, under the new password.
    expect(keyringService.keyrings).toHaveLength(1)
    const stored = JSON.parse(disk.read('keyringState').vault)
    expect(stored.password).toBe(NEW_PASSWORD)
    expect(stored.data).toHaveLength(1)
    expect(JSON.stringify(stored.data)).toContain(MNEMONIC)
    expect(JSON.stringify(stored.data)).not.toContain(OTHER_MNEMONIC)
  })

  it('makes boot wait for one a stale page began while nothing is booted, so the new vault holds only what is added after it', async () => {
    await createWallet()
    await wallet.resetWallet(PASSWORD)
    // A page still showing the erased wallet imports one: nothing is booted.
    const addition = holdImport()
    await addition.reached

    // The first-run page sets a new password.
    const booting = viaPort('tab:1', 'boot', NEW_PASSWORD)
    let bootEnded = false
    booting.then(
      () => (bootEnded = true),
      () => (bootEnded = true)
    )
    await sleep(50)
    // Boot neither ends nor sets a password while the addition is under way.
    expect(bootEnded).toBe(false)
    expect(keyringService.isBooted()).toBe(false)
    addition.release()

    // The addition is refused for want of a password and saves nothing; boot
    // then sets the new one over an empty vault.
    expect(
      await addition.importing.then(
        () => 'added',
        (error: Error) => error.message
      )
    ).toBe('keyringcontroller_password_is_not_a_string')
    await expect(booting).resolves.toBeUndefined()
    expect(keyringService.isBooted()).toBe(true)
    expect(keyringService.keyrings).toHaveLength(0)
    expect(disk.read('keyringState').vault).toBeNull()
    // Under the new password, only what is added after boot is saved.
    await createWallet()
    const stored = JSON.parse(disk.read('keyringState').vault)
    expect(stored.password).toBe(NEW_PASSWORD)
    expect(stored.data).toHaveLength(1)
    expect(JSON.stringify(stored.data)).toContain(MNEMONIC)
    expect(JSON.stringify(stored.data)).not.toContain(OTHER_MNEMONIC)
  })

  it('still erases every wallet, the one added meanwhile included, for a reset asked for as such', async () => {
    await createWallet()
    const addition = holdImport()
    await addition.reached

    const resetting = viaUiPort('resetWallet', PASSWORD)
    await sleep(20)
    addition.release()
    await addition.importing.catch(() => undefined)

    await expect(resetting).resolves.toBeUndefined()
    expect(keyringService.isBooted()).toBe(false)
    expect(await diskHoldsAWallet()).toBe(false)
  })
})

describe("a wallet page's call held by a reset whose outcome is unknown", () => {
  /**
   * A reset whose erase of the vault lands while its erase of the public key
   * cache keeps failing, so that memory still holds the vault: it ends as of
   * unknown outcome once the erase, held, is released.
   */
  async function resetOfUnknownOutcome() {
    disk.failWrites(isPubkeyCacheErase, 99)
    const erase = disk.holdNextWrite(isEraseWrite)
    const resetting = viaUiPort('resetWallet', PASSWORD).catch((error: unknown) => error)
    await erase.started
    return { resetting, release: erase.release }
  }

  it('is refused as of unknown outcome too, and does not run', async () => {
    await seedWalletData()
    const reset = await resetOfUnknownOutcome()

    const setting = viaUiPort('setThemeMode', 'light').then(
      () => 'set',
      (error: unknown) => error
    )
    await sleep(20)
    reset.release()

    expect(await reset.resetting).toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })
    expect(await setting).toMatchObject({ code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN })
    expect(preferenceService.getThemeMode()).toBe('dark')
    expect(wallet.isUnlocked()).toBe(false)
    expect(uiMethods()).not.toContain(BUS_METHODS.WALLET_RESET)
  })

  it('refuses a change of the password, which would save the vault memory still holds back to storage', async () => {
    await createWallet()
    const reset = await resetOfUnknownOutcome()

    const changing = viaUiPort('changePassword', PASSWORD, NEW_PASSWORD).then(
      () => 'changed',
      (error: unknown) => error
    )
    await sleep(20)
    reset.release()

    expect(await reset.resetting).toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })
    expect(await changing).toMatchObject({ code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN })
    // Memory still holds the vault, and storage no wallet: no vault write
    // follows the erase, before or after the outcome.
    expect(keyringService.hasVault()).toBe(true)
    expect(vaultWritesAfterErase()).toEqual([])
    expect(await diskHoldsAWallet()).toBe(false)
  })
})

describe("a wallet page's call whose page closes while a reset holds it", () => {
  // A send the wallet built for an account that signs outside it, with the
  // bytes its signer handed back: what the signer page reserves with
  // reserveExternallySignedQbitSend, a claim filed under that page's port.
  const pubkey = hexToBytes('22'.repeat(32))
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const address = p2mrAddressFromPubkey(pubkey, 'regtest')
  const externalAccount = {
    type: KeyringType.ReadonlyKeyring,
    address,
    pubkey: bytesToHex(pubkey),
    key: 'keyring_1#0',
    flag: 0,
    index: 0,
  }

  function externallySignedSend(): [ToSignData, string] {
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(7), vout: 0 },
          witnessUtxo: { value: 50_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 40_000n, scriptPubKey: p2mrScriptPubKey(leafHash) }],
    })
    const request: ToSignData = {
      psbtHex: bytesToHex(serializePsbt(psbt)),
      toSignInputs: [],
      qbitP2mrSigningKeys: [
        { inputIndex: 0, publicKey: bytesToHex(pubkey), leafHash: bytesToHex(leafHash) },
      ],
    }
    const signed = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(9),
    }).psbt
    return [request, bytesToHex(serializePsbt(finalizeP2mrPsbt(signed)))]
  }

  const reserved = () =>
    qbitSendGuardService.getReservedOutpointKeys(ChainType.QBIT_REGTEST, address)

  it('does not run once a reset that erased nothing ends, so it leaves no signing, hold or claim', async () => {
    await createWallet()
    vi.spyOn(preferenceService, 'getCurrentAccount').mockReturnValue(externalAccount as any)
    vi.spyOn(preferenceService, 'getChainType').mockReturnValue(ChainType.QBIT_REGTEST)
    const reserve = vi.spyOn(wallet, 'reserveExternallySignedQbitSend')
    // Window A's reset, refused for its password, which it checks meanwhile.
    const checking = deferred()
    const answer = deferred()
    const verify = keyringService.verifyPassword.bind(keyringService)
    vi.spyOn(keyringService, 'verifyPassword').mockImplementationOnce(async password => {
      checking.resolve()
      await answer.promise
      return verify(password)
    })
    const resetting = viaUiPort('resetWallet', 'not the password').catch((error: unknown) => error)
    await checking.promise

    // Window B reserves the send it signed, and closes while the call waits.
    const reserving = viaPort(
      'tab:2',
      'reserveExternallySignedQbitSend',
      ...externallySignedSend()
    ).then(
      () => 'reserved',
      (error: Error) => error.message
    )
    await sleep(20)
    await wallet.onUiPortDisconnected('tab:2')
    answer.resolve()

    expect(await resetting).toMatchObject({ message: 'password_error' })
    expect(await reserving).toBe(PAGE_CLOSED)
    expect(reserve).not.toHaveBeenCalled()
    expect(await reserved()).toEqual(new Set())
    expect(internals().localSignings.size).toBe(0)
    expect(internals().autoLockHoldPages.size).toBe(0)
    expect(internals().autoLockHoldEndsAt).toBeUndefined()
    expect(internals().qbitUtxoSnapshotWaiters.has('tab:2')).toBe(false)

    // The same call from a page still open reserves the send, and its close
    // releases it: what the closed page's call would have left for good.
    await viaPort('tab:3', 'reserveExternallySignedQbitSend', ...externallySignedSend())
    expect((await reserved()).size).toBe(1)
    await wallet.onUiPortDisconnected('tab:3')
    expect(await reserved()).toEqual(new Set())
  })
})

describe('a reset that fails before the keys begin to be erased', () => {
  it.each([
    [
      'the lock',
      () => vi.spyOn(keyringService, 'setLocked').mockRejectedValueOnce(new Error('lock failed')),
      'lock failed',
    ],
    [
      'the wait for the vault writes under way',
      () => vi.spyOn(keyringService, 'persistAllKeyrings').mockResolvedValueOnce(true),
      'The wallet was unlocked while it was being reset; nothing was erased',
    ],
  ])('takes back its pending mark when %s fails, erasing nothing', async (_, fail, message) => {
    await createWallet()
    fail()

    await expect(wallet.resetWallet(PASSWORD)).rejects.toThrow(message)

    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(disk.read('preference').walletResetPending).toBeUndefined()
    expect(keyringService.isBooted()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
    expect(uiMethods()).not.toContain(BUS_METHODS.WALLET_RESET)
  })

  it('leaves the mark when it cannot take it back, and the mark erases nothing', async () => {
    await createWallet()
    vi.spyOn(keyringService, 'setLocked').mockRejectedValueOnce(new Error('lock failed'))
    disk.failWrites(
      (key, value) => key === 'preference' && value?.walletResetPending === undefined,
      1
    )

    await expect(wallet.resetWallet(PASSWORD)).rejects.toThrow('lock failed')

    expect(preferenceService.getWalletResetPending()).toBe(true)
    expect(disk.read('preference').walletResetPending).toBe(true)
    // Beside a wallet that still exists, a mark is ignored.
    await expect(wallet.finishPendingWalletReset()).resolves.toBe(false)
    expect(keyringService.isBooted()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
  })
})

describe('a read a page began before a reset erased the wallets', () => {
  it('saves no balance for the erased address once the explorer answers after the reset', async () => {
    await createWallet()
    const address = preferenceService.getCurrentAccount()!.address
    const asked = deferred()
    let answer!: (balance: unknown) => void
    vi.spyOn(wallet as any, 'getQbitApiClient').mockReturnValueOnce({
      getAddressBalance: () => {
        asked.resolve()
        return new Promise(resolve => (answer = resolve))
      },
    })
    const reading = viaUiPort('getAddressBalance', address)
    await asked.promise

    await wallet.resetWallet(PASSWORD)
    answer({ confirmedSats: 1_000, mempoolSats: 0, totalSats: 1_000 })
    await reading

    expect(preferenceService.getAddressBalance(address)).toBeNull()
    await preferenceService.persist()
    expect(JSON.stringify(disk.read('preference'))).not.toContain(address)
  })

  it('stores no current wallet from the wallets it read before the reset erased them', async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const [first] = await wallet.getKeyrings()
    await wallet.removeKeyring(first as any)
    // A pointer left at the slot the removal emptied, which a fresh store
    // holds too: the read falls back to the next usable wallet and stores it.
    preferenceService.setCurrentKeyringIndex(0)
    const read = deferred()
    const goOn = deferred()
    const readAll = keyringService.getAllDisplayedKeyrings.bind(keyringService)
    vi.spyOn(keyringService, 'getAllDisplayedKeyrings').mockImplementationOnce(async (...args) => {
      const wallets = await readAll(...args)
      read.resolve()
      await goOn.promise
      return wallets
    })
    const reading = viaUiPort('getCurrentKeyring')
    await read.promise

    await wallet.resetWallet(PASSWORD)
    goOn.resolve()

    expect(await reading).toBeNull()
    expect(preferenceService.getCurrentAccount()).toBeNull()
    expect(preferenceService.getCurrentKeyringIndex()).toBe(0)
  })
})

describe("a wallet page's call made while a completion clears the wallet data", () => {
  const BOB = { name: 'Bob', address: 'qb1zbob', chain: ChainType.QBIT_MAINNET, isContact: true }
  /** The completion's write of the preferences, last of its steps. */
  const isPreferenceReset: WriteMatch = (key, value) =>
    key === 'preference' &&
    value?.walletResetPending === undefined &&
    JSON.stringify(value?.keyringAlianNames) === '{}'

  /** A reset that erased the keys and left the rest pending: both biometric clears fail. */
  async function pendingReset() {
    await seedWalletData()
    disk.failWrites(isBiometricWrite, 2)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })
    disk.stopFailing()
  }

  it('is held by the completion at the start of the background, and refused once it ends: no contact reaches the next wallet', async () => {
    await pendingReset()
    // The worker restarts: every service loads what is on the disk.
    await startServices()
    wallet = newController()
    const preferencesReset = disk.holdNextWrite(isPreferenceReset)
    const finishing = wallet.finishPendingWalletReset()
    await preferencesReset.started

    // A page still showing the erased wallet adds a contact after the
    // contacts were cleared, before the completion ends.
    const adding = viaUiPort('addContact', BOB).then(
      () => 'added',
      (error: Error) => error.message
    )
    await sleep(20)
    preferencesReset.release()

    await expect(finishing).resolves.toBe(true)
    expect(await adding).toBe(CALL_REFUSED)
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    expect(contactBookService.listContacts()).toEqual([])
    expect(disk.read('contactBook')).toEqual({})
  })

  it('is held by the completion inside boot, and refused once it ends, while boot itself sets the password', async () => {
    await pendingReset()
    const preferencesReset = disk.holdNextWrite(isPreferenceReset)
    // The first-run page asks for boot: its own call is the completion's.
    const booting = viaPort('tab:1', 'boot', NEW_PASSWORD)
    await preferencesReset.started

    const adding = viaUiPort('addContact', BOB).then(
      () => 'added',
      (error: Error) => error.message
    )
    // A call of the first-run page itself meanwhile waits too: it reads
    // what the completion is clearing, and is refused once it ends.
    const reading = viaPort('tab:1', 'isBooted').then(
      () => 'read',
      (error: Error) => error.message
    )
    await sleep(20)
    preferencesReset.release()

    await expect(booting).resolves.toBeUndefined()
    expect(await adding).toBe(CALL_REFUSED)
    expect(await reading).toBe(CALL_REFUSED)
    expect(wallet.isUnlocked()).toBe(true)
    await createWallet()
    expect(contactBookService.listContacts()).toEqual([])
  })
})

describe("a site's balance read a reset overtakes", () => {
  it('keeps no balance of the account it chose before the reset erased the wallets', async () => {
    // The provider reads through the background's own controller.
    await import('reflect-metadata')
    const { default: provider } = await import('../src/controllers/provider/controller')
    const { default: background } = await import('../src/controllers/wallet')
    await createWallet()
    const address = preferenceService.getCurrentAccount()!.address
    // The site's getBalance chooses the current account, then waits.
    const chosen = deferred()
    const goOn = deferred()
    const currentAccount = background.getCurrentAccount
    vi.spyOn(background, 'getCurrentAccount').mockImplementationOnce(async () => {
      const account = await currentAccount()
      chosen.resolve()
      await goOn.promise
      return account
    })
    vi.spyOn(background as any, 'getQbitApiClient').mockReturnValueOnce({
      getAddressBalance: async () => ({ confirmedSats: 1_000, mempoolSats: 0, totalSats: 1_000 }),
    })
    const reading = provider.getBalance()
    await chosen.promise

    // The reset erases the wallets before the balance is even asked for.
    await background.resetWallet(PASSWORD)
    goOn.resolve()

    await expect(reading).resolves.toMatchObject({ total: 1_000 })
    expect(preferenceService.getAddressBalance(address)).toBeNull()
    await preferenceService.persist()
    expect(JSON.stringify(disk.read('preference'))).not.toContain(address)
  })
})

describe("the wallet's identity a page reads", () => {
  const walletId = () => viaUiPort('getWalletId') as Promise<string | null>
  const storedId = () => disk.read('preference')?.walletId

  it('is null before a wallet is set up, made once on first read, and null again after a reset', async () => {
    // A new install: nothing booted.
    disk = new Disk()
    await startServices()
    wallet = newController()
    expect(await walletId()).toBeNull()
    await wallet.boot(PASSWORD)
    await createWallet()

    const id = await walletId()

    expect(id).toMatch(/^[0-9a-f]{32}$/)
    // Saved before it was returned.
    expect(storedId()).toBe(id)
    await wallet.resetWallet(PASSWORD)
    expect(await walletId()).toBeNull()
    expect(storedId()).toBeUndefined()
  })

  it('stays the same through lock, unlock, a password change, an addition, a switch, a removal and a restart', async () => {
    await createWallet()
    const id = await walletId()

    await wallet.lockWallet()
    expect(await walletId()).toBe(id)
    await wallet.unlock(PASSWORD)
    await viaUiPort('changePassword', PASSWORD, NEW_PASSWORD)
    expect(await walletId()).toBe(id)
    await createWallet(OTHER_MNEMONIC)
    expect(await walletId()).toBe(id)
    const [first] = await wallet.getKeyrings()
    await wallet.changeKeyring(first as any)
    expect(await walletId()).toBe(id)
    await wallet.removeKeyring(first as any)
    expect(await walletId()).toBe(id)
    // The worker restarts on the same storage.
    await startServices()
    wallet = newController()
    expect(await walletId()).toBe(id)
    await wallet.unlock(NEW_PASSWORD)
    expect(await walletId()).toBe(id)
    expect(storedId()).toBe(id)
  })

  it('differs for the next wallet after a reset', async () => {
    await createWallet()
    const before = await walletId()

    await wallet.resetWallet(PASSWORD)
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    const after = await walletId()

    expect(after).toMatch(/^[0-9a-f]{32}$/)
    expect(after).not.toBe(before)
  })

  it('is the same for two first reads at once, which make one', async () => {
    await createWallet()
    const writesBefore = disk.writes.filter(write => write.value?.walletId).length

    const [first, second] = await Promise.all([walletId(), walletId()])

    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toBe(first)
    const made = new Set(
      disk.writes
        .slice(writesBefore)
        .map(write => write.value?.walletId)
        .filter(Boolean)
    )
    expect([...made]).toEqual([first])
  })

  it('is unchanged by a reset refused for its password, and by one of unknown outcome', async () => {
    await createWallet()
    const id = await walletId()

    await expect(wallet.resetWallet('not the password')).rejects.toThrow('password_error')
    expect(await walletId()).toBe(id)
    disk.failWrites(isPubkeyCacheErase, 99)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })
    // The wallet is still loaded, locked.
    expect(await walletId()).toBe(id)
  })

  it('is gone once the restart after a reset of unknown outcome finishes it', async () => {
    await createWallet()
    await walletId()
    disk.failWrites(isPubkeyCacheErase, 99)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })
    disk.stopFailing()

    await startServices()
    wallet = newController()
    await expect(wallet.finishPendingWalletReset()).resolves.toBe(true)

    expect(await walletId()).toBeNull()
    expect(storedId()).toBeUndefined()
  })

  /** The save of the preferences that writes a new wallet id. */
  const isIdSave: WriteMatch = (key, value) =>
    key === 'preference' && typeof value?.walletId === 'string'

  it('hands out an id only once it is on disk: a read during its first save waits for that save', async () => {
    await createWallet()
    const save = disk.holdNextWrite(isIdSave)
    const making = walletId()
    await save.started

    let readEnded = false
    const reading = walletId().then(id => {
      readEnded = true
      return id
    })
    await sleep(20)
    expect(readEnded).toBe(false)
    save.release()

    const [made, read] = await Promise.all([making, reading])
    expect(made).toMatch(/^[0-9a-f]{32}$/)
    expect(read).toBe(made)
    expect(storedId()).toBe(made)
  })

  it('hands out no id whose save failed: a read during it fails with it, and later reads agree on the next', async () => {
    await createWallet()
    const save = disk.holdNextWrite(isIdSave)
    disk.failWrites(isIdSave, 1)
    const making = walletId().then(
      () => 'made',
      (error: Error) => error.message
    )
    await save.started
    const reading = walletId().then(
      () => 'read',
      (error: Error) => error.message
    )
    await sleep(20)
    save.release()

    expect(await making).toBe('disk full')
    expect(await reading).toBe('disk full')
    expect(preferenceService.getWalletId()).toBeUndefined()
    expect(storedId()).toBeUndefined()
    const [next, again] = await Promise.all([walletId(), walletId()])
    expect(next).toMatch(/^[0-9a-f]{32}$/)
    expect(again).toBe(next)
    expect(storedId()).toBe(next)
    expect(await walletId()).toBe(next)
  })

  it('is neither made nor saved by a read a reset overtook', async () => {
    await createWallet()
    // A change saved before it holds the read's turn to save.
    const earlier = disk.holdNextWrite(key => key === 'preference')
    const saving = preferenceService.setAutoLockTimeId(3)
    await earlier.started
    const reading = walletId()
    await sleep(10)

    // A reset begins to erase the wallets, as eraseWallet moves the generation.
    wallet.walletResetGeneration += 1
    earlier.release()
    await saving

    expect(await reading).toBeNull()
    expect(preferenceService.getWalletId()).toBeUndefined()
    expect(storedId()).toBeUndefined()
  })
})

describe("a page's copy of a wallet a reset erased, once the next wallet takes its slot", () => {
  // Two public keys a wallet can be imported by: the generator point and its double.
  const ERASED_PUBKEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  const NEXT_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const pageCopy = async (index = 0) =>
    JSON.parse(JSON.stringify((await wallet.getKeyrings())[index]))
  const NO_LONGER = 'The selected wallet is no longer available'

  /** An imported-key wallet, then a reset, a new password and the next imported-key wallet in slot 0. */
  async function walletAfterReset() {
    await wallet.createKeyringWithPublicKey(ERASED_PUBKEY, AddressType.P2WPKH)
    const erased = await pageCopy()
    await wallet.resetWallet(PASSWORD)
    await wallet.boot(NEW_PASSWORD)
    await wallet.createKeyringWithPublicKey(NEXT_PUBKEY, AddressType.P2WPKH)
    const next = await pageCopy()
    expect([erased.index, next.index]).toEqual([0, 0])
    return { erased, next }
  }

  it("is refused by a read of the addresses by type, which caches nothing of it for the next wallet's slot", async () => {
    const { erased, next } = await walletAfterReset()

    // A page that missed the reset reads its old copy's addresses.
    await expect(viaUiPort('getAllAddresses', erased, 0)).rejects.toThrow(NO_LONGER)

    expect(JSON.stringify(disk.read('cached_pubkeys') ?? null)).not.toContain(ERASED_PUBKEY)
    // The next wallet's own read lists its addresses, and none of the erased one's.
    const own = (await viaUiPort('getAllAddresses', next, 0)) as string[]
    expect(own).toContain(next.accounts[0].address)
    expect(own).not.toContain(erased.accounts[0].address)
    expect(JSON.stringify(disk.read('cached_pubkeys'))).toContain(NEXT_PUBKEY)
    expect(JSON.stringify(disk.read('cached_pubkeys'))).not.toContain(ERASED_PUBKEY)
  })

  it("is refused by a rename of its account, which leaves the next wallet's account name alone", async () => {
    const { erased, next } = await walletAfterReset()
    const name = preferenceService.getAccountAlianName(next.accounts[0].key)

    await expect(
      viaUiPort('setAccountAlianName', erased.accounts[0], 'Old savings')
    ).rejects.toThrow('The selected account is no longer available')

    expect(preferenceService.getAccountAlianName(next.accounts[0].key)).toBe(name)
    // The next wallet's own account is renamed as usual.
    await expect(
      viaUiPort('setAccountAlianName', next.accounts[0], 'Savings')
    ).resolves.toMatchObject({ alianName: 'Savings' })
    expect(preferenceService.getAccountAlianName(next.accounts[0].key)).toBe('Savings')
  })

  it('leaves the read of a live wallet as it was', async () => {
    await createWallet()
    const live = await pageCopy()

    const first = (await viaUiPort('getAllAddresses', live, 0)) as string[]

    expect(first).toContain(live.accounts[0].address)
    // A second read comes from the cache the first saved, unchanged.
    await expect(viaUiPort('getAllAddresses', live, 0)).resolves.toEqual(first)
  })
})

describe('renames of an account', () => {
  it('land in the order they came in, the first one read held', async () => {
    await createWallet()
    const account = JSON.parse(JSON.stringify(preferenceService.getCurrentAccount()))
    const read = deferred()
    const goOn = deferred()
    const getKeyrings = wallet.getKeyrings
    vi.spyOn(wallet, 'getKeyrings').mockImplementationOnce(async () => {
      read.resolve()
      await goOn.promise
      return getKeyrings()
    })
    const first = viaUiPort('setAccountAlianName', account, 'First')
    await read.promise

    const second = viaUiPort('setAccountAlianName', account, 'Second')
    await sleep(20)
    goOn.resolve()
    await Promise.all([first, second])

    expect(preferenceService.getAccountAlianName(account.key)).toBe('Second')
  })
})

describe('the address type screen', () => {
  const IMPORTED_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  /** The wallet as the page's reload reads it. */
  const pageWallet = async () => JSON.parse(JSON.stringify(await viaUiPort('getCurrentKeyring')))
  const addresses = (keyring: unknown) =>
    viaUiPort('getAllAddresses', keyring, 0) as Promise<string[]>

  it('reads the addresses of an imported-key wallet with the copy the page reloads after a change of address type and of network', async () => {
    await wallet.createKeyringWithPublicKey(IMPORTED_PUBKEY, AddressType.P2WPKH)
    const onOpen = await pageWallet()
    const first = await addresses(onOpen)

    await viaUiPort('changeAddressType', AddressType.P2TR)
    const afterTypeChange = await pageWallet()
    const second = await addresses(afterTypeChange)
    await viaUiPort('setChainType', ChainType.QBIT_TESTNET4)
    const onTestnet = await pageWallet()
    const third = await addresses(onTestnet)

    expect(afterTypeChange.addressType).toBe(AddressType.P2TR)
    expect(first).toContain(onOpen.accounts[0].address)
    expect(second).toContain(afterTypeChange.accounts[0].address)
    expect(third).toContain(onTestnet.accounts[0].address)
    // The same key, read for the same address types on another network.
    expect(second).toEqual(first)
    expect(third).not.toEqual(first)
  })

  it('takes a copy from before those changes as the same wallet: the same key in the same slot', async () => {
    await wallet.createKeyringWithPublicKey(IMPORTED_PUBKEY, AddressType.P2WPKH)
    const onOpen = await pageWallet()
    await viaUiPort('changeAddressType', AddressType.P2TR)
    await viaUiPort('setChainType', ChainType.QBIT_TESTNET4)

    const fromBefore = await addresses(onOpen)

    expect(fromBefore).toEqual(await addresses(await pageWallet()))
  })

  it('reads, with a copy of a phrase wallet from before its address type changed in another window, its current addresses', async () => {
    await createWallet()
    // Window A opened with the wallet as it was.
    const windowA = await pageWallet()

    // Window B changes the wallet's address type: every account is derived again.
    await viaUiPort('changeAddressType', AddressType.P2TR)
    const reloaded = await pageWallet()
    expect(reloaded.accounts[0].pubkey).not.toBe(windowA.accounts[0].pubkey)

    // Window A opens Address Type with its copy: read by slot, from the wallet in it.
    const fromWindowA = await addresses(windowA)
    expect(fromWindowA).toEqual(await addresses(reloaded))
    expect(fromWindowA).toContain(reloaded.accounts[0].address)
  })

  it("reads, with a copy of a phrase wallet a reset erased, only the next phrase wallet's own addresses in that slot", async () => {
    await createWallet()
    const erased = await pageWallet()
    const erasedAddresses = await addresses(erased)
    await wallet.resetWallet(PASSWORD)
    await wallet.boot(NEW_PASSWORD)
    await createWallet(OTHER_MNEMONIC)
    const next = await pageWallet()

    // No wallet id with the read: the copy names slot 0 and a phrase wallet.
    const read = await addresses(erased)

    expect(read).toEqual(await addresses(next))
    expect(read).toContain(next.accounts[0].address)
    for (const address of erasedAddresses) expect(read).not.toContain(address)
    expect(JSON.stringify(disk.read('cached_pubkeys'))).not.toContain(erased.accounts[0].pubkey)
  })
})

describe('a wallet page that names the wallet it shows', () => {
  const BOB = { name: 'Bob', address: 'qb1zbob', chain: ChainType.QBIT_MAINNET, isContact: true }
  const OTHER_ID = 'ff'.repeat(16)
  const OUT_OF_DATE = { code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE }
  const names = () => contactBookService.listContacts().map(contact => contact.name)
  const shownId = async () => (await viaUiPort('getWalletId')) as string

  it('has its request run when that is the wallet set up now, and as today without it', async () => {
    await createWallet()
    const id = await shownId()

    await expect(viaPageShowing(id, 'addContact', BOB)).resolves.toBeUndefined()
    await expect(viaPageShowing(undefined, 'listContacts')).resolves.toHaveLength(1)

    expect(names()).toEqual(['Bob'])
  })

  it('is refused, the method never run, when it names another wallet: a write and a read alike', async () => {
    await createWallet()
    await shownId()
    const add = vi.spyOn(contactBookService, 'addContact')
    const read = vi.spyOn(wallet, 'getCurrentAccount')

    await expect(viaPageShowing(OTHER_ID, 'addContact', BOB)).rejects.toMatchObject(OUT_OF_DATE)
    await expect(viaPageShowing(OTHER_ID, 'getCurrentAccount')).rejects.toMatchObject(OUT_OF_DATE)

    expect(add).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(names()).toEqual([])
    expect(disk.read('contactBook') ?? {}).toEqual({})
  })

  it('is refused when it names a wallet while none is set up, and when the wallet set up has no id yet', async () => {
    await createWallet()
    const id = await shownId()
    await wallet.resetWallet(PASSWORD)

    await expect(viaPageShowing(id, 'listContacts')).rejects.toMatchObject(OUT_OF_DATE)
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    // The next wallet has made no id yet: none matches.
    await expect(viaPageShowing(id, 'listContacts')).rejects.toMatchObject(OUT_OF_DATE)
  })

  it.each([null, '', 7, { id: 'x' }])(
    'is refused as malformed when its id is %j',
    async walletId => {
      await createWallet()
      await shownId()
      const add = vi.spyOn(contactBookService, 'addContact')

      await expect(viaPageShowing(walletId, 'addContact', BOB)).rejects.toThrow(
        'Invalid wallet request wallet id'
      )

      expect(add).not.toHaveBeenCalled()
    }
  )

  it('is not judged before the background has loaded the keyring and the preferences, and is from then on', async () => {
    await createWallet()
    await shownId()
    const keyring = keyringService as unknown as { store: unknown }
    const preferences = preferenceService as unknown as { initialized: boolean }
    const loadedKeyring = keyring.store
    try {
      // As a worker that has just started again: neither is loaded yet.
      keyring.store = undefined
      preferences.initialized = false
      await expect(viaPageShowing(OTHER_ID, 'getBackgroundStartupStatus')).resolves.toEqual({
        state: 'starting',
      })
      // The keyring loads first.
      keyring.store = loadedKeyring
      await expect(viaPageShowing(OTHER_ID, 'getBackgroundStartupStatus')).resolves.toEqual({
        state: 'starting',
      })
    } finally {
      keyring.store = loadedKeyring
      preferences.initialized = true
    }

    await expect(viaPageShowing(OTHER_ID, 'getBackgroundStartupStatus')).rejects.toMatchObject(
      OUT_OF_DATE
    )
  })

  it('may still ask, as the page of the wallet a reset erased, for the reset that finishes the clearing', async () => {
    await createWallet()
    const oldId = await shownId()
    disk.failWrites(isBiometricWrite, 2)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })
    disk.stopFailing()

    // Nothing is booted: whatever its password, the reset only finishes the clearing.
    await expect(viaPageShowing(oldId, 'resetWallet', 'any password')).resolves.toBeUndefined()

    expect(preferenceService.getWalletResetPending()).toBe(false)
    expect(disk.read('preference')).not.toHaveProperty('walletResetPending')
    // Anything else it asks is still refused.
    await expect(viaPageShowing(oldId, 'listContacts')).rejects.toMatchObject(OUT_OF_DATE)
  })

  it('is refused that reset when a boot queued ahead of it sets up a wallet, which it leaves alone', async () => {
    await createWallet()
    const oldId = await shownId()
    await wallet.resetWallet(PASSWORD)
    // Window A's first-run boot, held in its queued step before the password is set.
    const keyringBoot = keyringService.boot.bind(keyringService)
    const booting = deferred()
    const goOn = deferred()
    vi.spyOn(keyringService, 'boot').mockImplementationOnce(async password => {
      booting.resolve()
      await goOn.promise
      return keyringBoot(password)
    })
    const boot = viaPort('tab:1', 'boot', PASSWORD)
    await booting.promise

    // Stale window B, still showing the erased wallet, asks for a reset with
    // the same password: nothing is booted yet, so it is let through and
    // queues behind the boot.
    const resetting = viaPageShowing(oldId, 'resetWallet', PASSWORD).catch(
      (error: unknown) => error
    )
    await sleep(10)
    goOn.resolve()
    await boot
    await createWallet(OTHER_MNEMONIC)

    expect(await resetting).toMatchObject(OUT_OF_DATE)
    expect(keyringService.isBooted()).toBe(true)
    expect(keyringService.keyrings).toHaveLength(1)
    expect(await diskHoldsAWallet()).toBe(true)
    const stored = JSON.parse(disk.read('keyringState').vault)
    expect(stored.password).toBe(PASSWORD)
    expect(JSON.stringify(stored.data)).toContain(OTHER_MNEMONIC)
    expect(preferenceService.getWalletResetPending()).toBe(false)
  })

  it('may still reset, naming it, the wallet set up now', async () => {
    await createWallet()
    const id = await shownId()

    await expect(viaPageShowing(id, 'resetWallet', PASSWORD)).resolves.toBeUndefined()

    expect(keyringService.isBooted()).toBe(false)
    expect(await diskHoldsAWallet()).toBe(false)
  })

  it('is refused that reset once another wallet is set up, which it leaves alone', async () => {
    await createWallet()
    const oldId = await shownId()
    await wallet.resetWallet(PASSWORD)
    await wallet.boot(NEW_PASSWORD)
    await createWallet(OTHER_MNEMONIC)

    await expect(viaPageShowing(oldId, 'resetWallet', NEW_PASSWORD)).rejects.toMatchObject(
      OUT_OF_DATE
    )

    expect(keyringService.isBooted()).toBe(true)
    expect(await diskHoldsAWallet()).toBe(true)
  })

  /**
   * The chain-state queue held busy, as a long change the background runs
   * holds it, until `release`; then window B's reset and a first-run page's
   * boot under the same password queue behind it.
   */
  async function resetAndBootQueuedBehindBusyQueue(oldId: string) {
    const busy = deferred()
    void (wallet as any).enqueueChainStateChange(() => busy.promise)
    const resetting = viaPageShowing(oldId, 'resetWallet', PASSWORD)
    const booting = viaPort('tab:9', 'boot', PASSWORD)
    await sleep(0)
    return { release: busy.resolve, resetting, booting }
  }

  it("refuses, when its job starts, a page's restore queued behind a reset and the next wallet's boot", async () => {
    // Were it to run, the restore would complete: PQC is ready, and the chain
    // shows no activity for the phrase's first address.
    await initPqc()
    const unused = {
      funded_txo_count: 0,
      funded_txo_sum: 0,
      spent_txo_count: 0,
      spent_txo_sum: 0,
      tx_count: 0,
    }
    vi.spyOn(wallet as any, 'getQbitApiClient').mockReturnValue({
      getAddressStats: async (address: string) => ({
        address,
        chain_stats: unused,
        mempool_stats: unused,
      }),
    })
    await createWallet()
    const oldId = await shownId()
    const queued = await resetAndBootQueuedBehindBusyQueue(oldId)

    // Window A, still showing the erased wallet, restores a phrase: judged
    // when it arrives, as that wallet is still set up, and queued.
    const restoring = viaPageShowing(
      oldId,
      'restoreQbitKeyringWithFloors',
      MNEMONIC,
      "m/87'/0'/0'/0",
      '',
      AddressType.P2MR,
      { gapLimit: 1, maxIndexes: 1 }
    ).catch((error: unknown) => error)
    await sleep(0)
    queued.release()

    await expect(queued.resetting).resolves.toBeUndefined()
    await expect(queued.booting).resolves.toBeUndefined()
    expect(await restoring).toMatchObject(OUT_OF_DATE)
    // The first-run page makes the next wallet: its vault holds only it.
    await createWallet(OTHER_MNEMONIC)
    const stored = JSON.parse(disk.read('keyringState').vault)
    expect(stored.password).toBe(PASSWORD)
    expect(stored.data).toHaveLength(1)
    expect(JSON.stringify(stored.data)).toContain(OTHER_MNEMONIC)
    expect(JSON.stringify(stored.data)).not.toContain(MNEMONIC)
  })

  it("refuses, when their jobs start, a page's unlock and removal queued behind a reset and the next wallet's boot", async () => {
    await createWallet()
    await createWallet(OTHER_MNEMONIC)
    const oldId = await shownId()
    const [first] = JSON.parse(JSON.stringify(await wallet.getKeyrings()))
    const queued = await resetAndBootQueuedBehindBusyQueue(oldId)
    const unlocking = viaPageShowing(oldId, 'unlock', PASSWORD).catch((error: unknown) => error)
    const removing = viaPageShowing(oldId, 'removeKeyring', first).catch((error: unknown) => error)
    await sleep(0)
    queued.release()

    await expect(queued.resetting).resolves.toBeUndefined()
    await expect(queued.booting).resolves.toBeUndefined()
    expect(await unlocking).toMatchObject(OUT_OF_DATE)
    expect(await removing).toMatchObject(OUT_OF_DATE)
    expect(keyringService.isBooted()).toBe(true)
    expect(keyringService.keyrings).toHaveLength(0)
  })

  it('runs a queued change whose wallet is still the one set up when its job starts', async () => {
    await createWallet()
    const id = await shownId()
    const busy = deferred()
    void (wallet as any).enqueueChainStateChange(() => busy.promise)

    const changing = viaPageShowing(id, 'changeAddressType', AddressType.P2TR)
    await sleep(0)
    busy.resolve()

    await expect(changing).resolves.toBeUndefined()
    expect((await wallet.getCurrentKeyring())?.addressType).toBe(AddressType.P2TR)
  })

  it('is not out of date during a reset of unknown outcome: the wallet is still loaded', async () => {
    await createWallet()
    const id = await shownId()
    disk.failWrites(isPubkeyCacheErase, 99)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_OUTCOME_UNKNOWN,
    })

    await expect(viaPageShowing(id, 'getWalletId')).resolves.toBe(id)
  })

  it('is held behind a reset it came in during, refused as erased once it ends, and out of date after', async () => {
    await createWallet()
    const id = await shownId()
    const marking = disk.holdNextWrite(
      (key, value) => key === 'preference' && value?.walletResetPending === true
    )
    const resetting = wallet.resetWallet(PASSWORD)
    await marking.started

    // Still the wallet set up: judged so, then held by the reset.
    const add = vi.spyOn(contactBookService, 'addContact')
    const adding = viaPageShowing(id, 'addContact', BOB).then(
      () => 'added',
      (error: Error) => error.message
    )
    await sleep(20)
    marking.release()

    await expect(resetting).resolves.toBeUndefined()
    expect(await adding).toBe(CALL_REFUSED)
    expect(add).not.toHaveBeenCalled()
    await expect(viaPageShowing(id, 'addContact', BOB)).rejects.toMatchObject(OUT_OF_DATE)
  })

  it("keeps a page that missed a reset finished at the background's start out of the next wallet's address book", async () => {
    await createWallet()
    const oldId = await shownId()
    // A reset that erased the keys and left the rest pending.
    disk.failWrites(isBiometricWrite, 2)
    await expect(wallet.resetWallet(PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })
    disk.stopFailing()
    // The worker restarts and finishes it, with no page there to be told.
    await startServices()
    wallet = newController()
    await expect(wallet.finishPendingWalletReset()).resolves.toBe(true)
    // Another window sets up the next wallet.
    await wallet.boot(NEW_PASSWORD)
    await createWallet(OTHER_MNEMONIC)
    const newId = await shownId()

    // The old page's next request carries the erased wallet's id.
    await expect(viaPageShowing(oldId, 'addContact', BOB)).rejects.toMatchObject(OUT_OF_DATE)

    expect(newId).not.toBe(oldId)
    expect(names()).toEqual([])
    expect(disk.read('contactBook') ?? {}).toEqual({})
  })
})

describe('an acknowledgement of local regtest access', () => {
  it('that a reset overtook while it read the browser permission stores nothing, and the next wallet stays locked', async () => {
    await createWallet()
    // Another window acknowledges; the browser's permission read waits.
    const adapter = (
      regtestAccessService as unknown as { adapter: { containsPermission(): Promise<boolean> } }
    ).adapter
    const asked = deferred()
    const answer = deferred()
    vi.spyOn(adapter, 'containsPermission').mockImplementationOnce(async () => {
      asked.resolve()
      await answer.promise
      return true
    })
    const acknowledging = viaUiPort('acknowledgeRegtestAccess').then(
      () => 'acknowledged',
      (error: { code?: number }) => error.code
    )
    await asked.promise

    await wallet.resetWallet(PASSWORD)
    answer.resolve()

    expect(await acknowledging).toBe(ErrorCodes.REGTEST_ACCESS_LOCKED)
    expect(preferenceService.getRegtestAccessAck()).toBeUndefined()
    await preferenceService.persist()
    expect(disk.read('preference')).not.toHaveProperty('regtestAccessAck')
    await wallet.boot(NEW_PASSWORD)
    await createWallet()
    expect(regtestAccessService.getStatus()).toMatchObject({ state: 'locked', acknowledged: false })
  })

  it('is stored as before when no reset comes in between', async () => {
    await createWallet()

    await viaUiPort('acknowledgeRegtestAccess')

    expect(preferenceService.getRegtestAccessAck()).toBe(REGTEST_ACCESS_ACK_VERSION)
    expect(regtestAccessService.getStatus()).toMatchObject({ acknowledged: true })
  })
})

describe('the send plans of the wallets a reset erases', () => {
  const CHAIN = ChainType.QBIT_MAINNET
  const PLAN_HD_PATH = "m/87'/0'/0'/0"
  const RECIPIENT_KEY = '44'.repeat(32)
  const RECIPIENT = p2mrAddressFromPubkey(hexToBytes(RECIPIENT_KEY), 'mainnet')
  const isPlanStoreWrite: WriteMatch = key => key === QBIT_SEND_PLAN_STORE_KEY
  const NO_PLAN = { version: 1, plans: [] }

  let timers: ManualTimers
  let explorer: FakeQbitExplorer
  /** The txid of every transaction the wallet broadcast, in order. */
  let pushed: string[]
  /** While set, a broadcast reaches the explorer and its answer waits for it. */
  let broadcastGate: { reached: () => void; gate: Promise<void> } | undefined
  let lockListeners: number

  const engine = () => (wallet as unknown as { qbitSendPlans: QbitSendPlanEngine }).qbitSendPlans
  const engineMemory = () =>
    engine() as unknown as { sessions: Map<string, unknown>; drafts: Map<string, unknown> }
  const planHeld = () => qbitSendGuardService.getPlanHeldOutpointKeys(CHAIN)
  const storedStatuses = () => qbitSendPlanStore.list()[0]?.steps.map(step => step.status) ?? []

  /** The explorer, served over fetch, as the controller's clients reach it. */
  const explorerFetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    if ((init?.method ?? 'GET') === 'POST' && url.pathname.endsWith('/tx')) {
      pushed.push(transactionCore.Transaction.fromHex(String(init?.body ?? '')).getId())
      const held = broadcastGate
      if (held) {
        const response = await explorer.fetch(input, init)
        held.reached()
        await held.gate
        return response
      }
    }
    return explorer.fetch(input, init)
  }

  /** The controller as a worker start makes it, its plans' timer run by hand. */
  function planController() {
    const controller = newController({ qbitSendPlanTimers: timers })
    controller.qbitBroadcastProbeDelayMs = 0
    controller.qbitBroadcastResendDelaysMs = [0, 0]
    controller.qbitRecentSpendProbeWaitMs = 0
    controller.qbitFeeBumpRecheckIntervalMs = 0
    return controller
  }

  /**
   * The send plans as the background's start takes them up (restore.ts): the
   * store loaded from the disk and its plans held again, then, once start-up
   * is over (after any pending reset is finished), advancing.
   */
  async function takeUpPlans({ finishPendingReset = false } = {}) {
    await qbitSendPlanStore.init({ storage: disk })
    await wallet.restoreQbitSendPlans()
    const finished = finishPendingReset ? await wallet.finishPendingWalletReset() : undefined
    wallet.startQbitSendPlanEngine()
    return finished
  }

  /**
   * The P2MR wallet of MNEMONIC, its one account holding 110 confirmed
   * outputs of 100,000 bits: a plan pays everything with one merge of 106
   * inputs and a payment. Its signatures are placeholders, SLH-DSA being slow.
   */
  async function createQbitWallet() {
    await wallet.createKeyringWithMnemonics(MNEMONIC, PLAN_HD_PATH, '', AddressType.P2MR, 1)
    vi.spyOn(keyringService.keyrings[0] as any, 'signPqcDigest').mockImplementation(async () =>
      new Uint8Array(PQC_SIGNATURE_BYTES).fill(7)
    )
    const account = (await wallet.getCurrentAccount())!
    if (!explorer.txs.size) {
      explorer.registerAddress(account.address, scriptOf(account.pubkey))
      for (let seed = 0; seed < 110; seed++) {
        explorer.addTx({
          txid: fakeTxid(seed, 7),
          inputs: [{ txid: fakeTxid(seed, 9_000_000), vout: 0 }],
          outputs: [{ address: account.address, script: scriptOf(account.pubkey), value: 100_000 }],
          height: 100 + seed,
        })
      }
    }
    return account
  }

  /** The review of a plan paying everything to RECIPIENT, as the popup prepares it. */
  async function reviewPlan() {
    const prepared = (await viaUiPort('prepareQbitSendPlan', {
      to: RECIPIENT,
      target: { kind: 'everything' },
      feeRate: 1,
    })) as { ok: boolean; review: { draftId: string; payment: { txid: string } } }
    expect(prepared.ok).toBe(true)
    return prepared.review
  }

  /** A plan started from the popup, its merge broadcast and its payment signed, waiting for the merge to confirm. */
  async function waitingPlan() {
    const review = await reviewPlan()
    expect(await viaUiPort('startQbitSendPlan', review.draftId)).toMatchObject({ ok: true })
    await engine().idle()
    expect(storedStatuses()).toEqual(['broadcast', 'signed'])
    expect(pushed).toHaveLength(1)
    return { mergeTxid: pushed[0]!, paymentTxid: review.payment.txid }
  }

  /** A block confirms what the network holds, and the plans' timer runs what is due. */
  async function confirmAndTick() {
    const height = ++explorer.tipHeight
    for (const tx of explorer.txs.values()) tx.height ??= height
    vi.setSystemTime(Date.now() + QBIT_SEND_PLAN_TICK_MS)
    timers.runDue()
    await engine().idle()
  }

  /** The next wallet, set up from the same phrase: the same account, and no plan of it. */
  async function expectNoPlanForTheNextWallet() {
    await viaPort('tab:9', 'boot', NEW_PASSWORD)
    await createQbitWallet()
    expect(await viaUiPort('getQbitSendPlan')).toBeNull()
    expect(qbitSendPlanStore.list()).toEqual([])
  }

  beforeEach(async () => {
    await initPqc()
    vi.useFakeTimers({ toFake: ['Date'] })
    timers = new ManualTimers()
    explorer = new FakeQbitExplorer(CHAINS_MAP[CHAIN]!.qbitApiSurface)
    explorer.registerAddress(RECIPIENT, scriptOf(RECIPIENT_KEY))
    pushed = []
    broadcastGate = undefined
    vi.stubGlobal('fetch', explorerFetch)
    lockListeners = keyringService.listenerCount('lock')
    wallet = planController()
    await takeUpPlans()
  })

  afterEach(() => {
    engine().reset()
    const added = keyringService.listeners('lock').slice(lockListeners)
    for (const listener of added) keyringService.off('lock', listener as () => void)
    vi.useRealTimers()
  })

  it('erases a plan whose payment is signed and not yet broadcast: nothing of it goes out after the reset, is kept, or comes back with the next wallet', async () => {
    await createQbitWallet()
    const { mergeTxid, paymentTxid } = await waitingPlan()

    // While the keys are being erased, the merge confirms and the plans'
    // timer runs: the signed payment, which needs no key, does not go.
    const erase = disk.holdNextWrite(isEraseWrite)
    const resetting = viaUiPort('resetWallet', PASSWORD)
    await erase.started
    await confirmAndTick()
    expect(pushed).toEqual([mergeTxid])
    erase.release()
    await resetting

    // Nor after the reset.
    await confirmAndTick()
    expect(pushed).toEqual([mergeTxid])
    expect(qbitSendPlanStore.list()).toEqual([])
    expect(disk.read(QBIT_SEND_PLAN_STORE_KEY)).toEqual(NO_PLAN)
    expect((await planHeld()).size).toBe(0)
    expect(engineMemory().sessions.size).toBe(0)
    expect(engineMemory().drafts.size).toBe(0)

    await expectNoPlanForTheNextWallet()
    await confirmAndTick()
    expect(pushed).toEqual([mergeTxid])
    expect(pushed).not.toContain(paymentTxid)
  })

  it("waits for a plan's broadcast under way as it begins, then broadcasts nothing more of the plan", async () => {
    await createQbitWallet()
    const review = await reviewPlan()
    let reached!: () => void
    const broadcasting = new Promise<void>(resolve => (reached = resolve))
    const gate = deferred()
    broadcastGate = { reached, gate: gate.promise }
    const starting = viaUiPort('startQbitSendPlan', review.draftId).catch((error: unknown) => error)
    // The merge is signed and the network has it; its answer is still on the way.
    await broadcasting
    expect(pushed).toHaveLength(1)

    const resetting = viaUiPort('resetWallet', PASSWORD)
    const before = await Promise.race([
      resetting.then(() => 'reset'),
      sleep(20).then(() => 'waiting'),
    ])
    gate.resolve()
    broadcastGate = undefined
    await resetting
    await starting

    // The reset waited for the broadcast; the payment was never signed or sent.
    expect(before).toBe('waiting')
    await confirmAndTick()
    expect(pushed).toHaveLength(1)
    expect(pushed).not.toContain(review.payment.txid)
    expect(disk.read(QBIT_SEND_PLAN_STORE_KEY)).toEqual(NO_PLAN)
    expect((await planHeld()).size).toBe(0)
    await expectNoPlanForTheNextWallet()
    await confirmAndTick()
    expect(pushed).toHaveLength(1)
  })

  it('is incomplete when its clearing fails after the keys are gone: the plans stay halted, nothing goes out, and the next start finishes the reset before any plan advances', async () => {
    await createQbitWallet()
    const { mergeTxid, paymentTxid } = await waitingPlan()
    // The stored plans cannot be erased, and the biometric unlock not cleared.
    disk.failWrites(isPlanStoreWrite, 1)
    disk.failWrites(isBiometricWrite, 2)

    await expect(viaUiPort('resetWallet', PASSWORD)).rejects.toMatchObject({
      code: ErrorCodes.WALLET_RESET_INCOMPLETE,
    })

    // The plan is still stored, and halted: the merge confirms and the timer
    // runs, and the signed payment does not go; a page reads no plan.
    expect(disk.read(QBIT_SEND_PLAN_STORE_KEY).plans).toHaveLength(1)
    await confirmAndTick()
    expect(pushed).toEqual([mergeTxid])
    expect(await viaUiPort('getQbitSendPlan')).toBeNull()

    // The worker restarts, the mark still set: start-up gives the plan back
    // and holds it again, then finishes the reset before the engine advances.
    disk.stopFailing()
    await startServices()
    wallet = planController()
    await expect(takeUpPlans({ finishPendingReset: true })).resolves.toBe(true)
    expect(disk.read(QBIT_SEND_PLAN_STORE_KEY)).toEqual(NO_PLAN)
    expect((await planHeld()).size).toBe(0)
    await confirmAndTick()
    expect(pushed).toEqual([mergeTxid])

    await expectNoPlanForTheNextWallet()
    await confirmAndTick()
    expect(pushed).not.toContain(paymentTxid)
  })
})
