import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The stored data that released builds wrote, as the README in this directory
 * describes. Each read returns fresh copies, so a test may change what it got.
 */

/** Every release with a capture here, oldest first. */
export const RELEASES = ['1.0.5', '1.0.6', '1.0.7'] as const

export type Release = (typeof RELEASES)[number]

/** Where a release's wallet pages save their `ui` state in `localStorage`. */
export const SAVED_UI_KEY = 'redux_localstorage_simple_ui'

/** What step 10 of the capture types on the send screen after the contact's address. */
export const CAPTURE_SEND_AMOUNT = '0.0001'

/**
 * The first release whose wallet pages save only their two display
 * preferences under `SAVED_UI_KEY`.
 */
export const FIRST_RELEASE_SAVING_PREFERENCES_ONLY = '1.0.9'

/** The parts of a release version such as `1.0.9`. */
function versionParts(version: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`${version} is not a release version such as 1.0.9`)
  return match.slice(1).map(Number)
}

/** Whether release `version` came before release `than`. */
function releasedBefore(version: string, than: string): boolean {
  const parts = versionParts(version)
  const thanParts = versionParts(than)
  const differ = parts.findIndex((part, index) => part !== thanParts[index])
  return differ !== -1 && parts[differ]! < thanParts[differ]!
}

/**
 * Whether `release` saved its whole `ui` state under `SAVED_UI_KEY`, with
 * the send form that step 10 of the capture types in: every release before
 * 1.0.9 did. From 1.0.9 a release saves its two display preferences there,
 * and nothing typed on the send screen. Told by the version, never by what a
 * capture holds, so that a capture that lost its send form fails the tests
 * instead of passing for one of a later release.
 */
export function savedWholeUi(release: string): boolean {
  return releasedBefore(release, FIRST_RELEASE_SAVING_PREFERENCES_ONLY)
}

/** The display preferences a release saved under `SAVED_UI_KEY`. */
export interface SavedPreferences {
  isBalanceHidden: boolean
  balanceDetailExpanded: boolean
}

/** What a release saved under `SAVED_UI_KEY` in a capture. */
export interface ReleaseSavedUi {
  /** The saved value, as the release stored it. */
  stored: string
  preferences: SavedPreferences
  /**
   * The send form that step 10 typed, as the release saved it with its whole
   * `ui` state; null for a release that saves the preferences alone.
   */
  sendForm: { address: string; amount: string } | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * What `release` saved under `SAVED_UI_KEY` in `items`, the extension
 * origin's `localStorage` after the capture's steps: step 10 hid the
 * balances, then typed `contactAddress` and `CAPTURE_SEND_AMOUNT` on the send
 * screen without sending. Throws unless the value is what that release saves
 * (`savedWholeUi`): its whole `ui` state, with that send form and the two
 * display preferences in it, or the two preferences alone. The capture checks
 * this before it writes a file, and the tests with every capture.
 */
export function releaseSavedUi(
  release: string,
  items: Readonly<Record<string, string>>,
  contactAddress: string
): ReleaseSavedUi {
  const what = `the ui state that ${release} saved`
  const stored = items[SAVED_UI_KEY]
  if (stored === undefined) throw new Error(`${what} is missing: no ${SAVED_UI_KEY}`)
  let saved: unknown
  try {
    saved = JSON.parse(stored)
  } catch {
    throw new Error(`${what} is not JSON: ${stored}`)
  }
  if (!isRecord(saved)) throw new Error(`${what} is not a JSON object: ${stored}`)
  const isBalanceHidden = saved['isBalanceHidden']
  const balanceDetailExpanded = saved['balanceDetailExpanded']
  if (isBalanceHidden !== true || typeof balanceDetailExpanded !== 'boolean') {
    throw new Error(`${what} does not hold the two preferences, balances hidden: ${stored}`)
  }
  const preferences = { isBalanceHidden, balanceDetailExpanded }

  if (!savedWholeUi(release)) {
    const fields = Object.keys(saved).sort().join(', ')
    if (fields !== 'balanceDetailExpanded, isBalanceHidden') {
      throw new Error(`${what} holds ${fields}, not the two display preferences alone: ${stored}`)
    }
    return { stored, preferences, sendForm: null }
  }

  const form = saved['uiTxCreateScreen']
  const toInfo = isRecord(form) ? form['toInfo'] : undefined
  const address = isRecord(toInfo) ? toInfo['address'] : undefined
  const amount = isRecord(form) ? form['inputAmount'] : undefined
  if (address !== contactAddress || amount !== CAPTURE_SEND_AMOUNT) {
    throw new Error(
      `${what} does not hold the send form typed in step 10 (${contactAddress}, ${CAPTURE_SEND_AMOUNT}), which releases before ${FIRST_RELEASE_SAVING_PREFERENCES_ONLY} saved: ${stored}`
    )
  }
  return { stored, preferences, sendForm: { address: contactAddress, amount: CAPTURE_SEND_AMOUNT } }
}

export interface ReleaseAccount {
  address: string
  pubkey: string
  alianName: string
}

export interface ReleaseKeyring {
  type: string
  alianName: string
  addressType: number
  accounts: ReleaseAccount[]
}

export interface ReleaseContact {
  name: string
  address: string
  chain: string
  isContact: boolean
  isAlias: boolean
  sortIndex?: number
}

export interface ReleaseConnectedSite {
  origin: string
  chain: string
  isConnected: boolean
}

/** What the capture set up, as the release itself reported it. Test-only. */
export interface ReleaseWallet {
  release: string
  zip: { name: string; sha256: string }
  extensionVersion: string
  userAgent: string
  testOnly: true
  password: string
  mnemonic: string
  readonlyPublicKey: string
  keyrings: ReleaseKeyring[]
  currentAccount: { address: string; alianName: string }
  contacts: ReleaseContact[]
  connectedSites: ReleaseConnectedSite[]
  settings: {
    chainType: string
    locale: string
    themeMode: string
    autoLockTimeId: number
    developerMode: boolean
  }
  /** Steps of the setup that this build could not take, if any. */
  notes?: string[]
}

export interface ReleaseStorage {
  release: Release
  /** chrome.storage.local, as chrome.storage.local.get(null) returned it. */
  storage: Record<string, unknown>
  /** The extension origin's localStorage. */
  localStorage: Record<string, string>
  wallet: ReleaseWallet
}

const readJson = (release: Release, name: string) =>
  JSON.parse(readFileSync(join(__dirname, release, name), 'utf8'))

export function readReleaseStorage(release: Release): ReleaseStorage {
  return {
    release,
    storage: readJson(release, 'chrome-storage-local.json'),
    localStorage: readJson(release, 'local-storage.json'),
    wallet: readJson(release, 'wallet.json'),
  }
}
