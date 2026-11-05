import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The stored data that released builds wrote, as the README in this directory
 * describes. Each read returns fresh copies, so a test may change what it got.
 */

/** Every release with a capture here, oldest first. */
export const RELEASES = ['1.0.5', '1.0.6', '1.0.7'] as const

export type Release = (typeof RELEASES)[number]

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
