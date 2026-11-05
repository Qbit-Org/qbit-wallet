import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { ApprovalsPage, OnboardingPage, SendPage, SettingsPage, WalletHomePage } from '../e2e/pages'
import { DappServer } from '../e2e/support/dapp-server'
import { ExtensionSession } from '../e2e/support/extension-session'
import { extensionDist } from '../e2e/support/paths'
import { OFFLINE_BROWSER_ARGS } from '../e2e/support/release-storage'
import { FIXED_MNEMONIC } from '../e2e/support/wallet-setup'

/**
 * A real Chrome update, as a user gets one: a published release is installed
 * from its ZIP, set up through its own screens, and then the 1.0.8 build
 * replaces it in the same directory and the same profile. The extension keeps
 * its id, so Chrome loads 1.0.8 over the release's stored data, the way the
 * Web Store update does. upgrade.spec.ts in the gate seeds captured data
 * instead; this run has the release write its own.
 */

// Directory holding qbit-chrome-mv3-v1.0.{5,6,7}.zip, the GitHub release assets.
const RELEASES_DIR = process.env['QBIT_UPGRADE_RELEASES_DIR'] ?? ''
// The 1.0.8 build to update to. Defaults to this checkout's build.
const TARGET_DIR = resolve(process.env['QBIT_UPGRADE_TARGET_DIR'] || extensionDist)

// The release assets, as tests/fixtures/release-storage/README.md records them.
const RELEASES = {
  'v1.0.5': 'a209c86146c275d12ad9f25b82f9e8efe5941685a7241ed5943668d3c1e90cb4',
  'v1.0.6': 'eef162762ab6b7ba04899da09dd6b209164d7cb96dfff315e5430d4110d4a30e',
  'v1.0.7': '7e36b57ae191a1738f370547c234f82070415d8dadac0a645b4f1b122855e748',
} as const

// Test-only wallet; never fund it.
const PASSWORD = 'Qbit-Chrome-Update-Test-Only!1'
const P2MR = 9
const QBIT_TESTNET4_HD_PATH = "m/87'/1'/0'/0"
const SECOND_ACCOUNT_NAME = 'Savings'
const CONTACT_NAME = 'Update contact'

interface AccountProbe {
  address: string
  alianName: string
}
interface KeyringProbe {
  key: string
  type: string
  alianName: string
  addressType: number
  accounts: AccountProbe[]
}
interface ContactProbe {
  name: string
  address: string
  chain: string
  isContact: boolean
  isAlias: boolean
}
interface SiteProbe {
  origin: string
  chain: string
  isConnected: boolean
}

async function snapshot(extension: ExtensionSession, page: Page) {
  const call = <T>(method: string) => extension.requestWalletController<T>(page, method)
  const keyrings = await call<KeyringProbe[]>('getKeyrings')
  const current = await call<AccountProbe>('getCurrentAccount')
  return {
    keyrings: keyrings.map(keyring => ({
      type: keyring.type,
      alianName: keyring.alianName,
      addressType: keyring.addressType,
      accounts: keyring.accounts.map(({ address, alianName }) => ({ address, alianName })),
    })),
    currentAccount: { address: current.address, alianName: current.alianName },
    contacts: (await call<ContactProbe[]>('listContacts'))
      .filter(contact => contact.isContact)
      .map(({ name, address, chain, isAlias }) => ({ name, address, chain, isAlias })),
    sites: (await call<SiteProbe[]>('getConnectedSites')).map(({ origin, chain, isConnected }) => ({
      origin,
      chain,
      isConnected,
    })),
    chainType: await call<string>('getChainType'),
    themeMode: await call<string>('getThemeMode'),
    autoLockTimeId: await call<number>('getAutoLockTimeId'),
  }
}

async function goTo(extension: ExtensionSession, page: Page, route: string) {
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#${route}`, {
    waitUntil: 'domcontentloaded',
  })
}

/** Set the release up through its own screens, as the release-storage capture does. */
async function setUpRelease(extension: ExtensionSession, origin: string) {
  const page = await extension.openWallet('/welcome')
  await new OnboardingPage(page).createNewWallet(PASSWORD)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  const call = <T>(method: string, params: unknown[] = []) =>
    extension.requestWalletController<T>(page, method, params)

  // A 1 hour auto-lock, so the release does not lock during the setup.
  await goTo(extension, page, '/settings/lock-time')
  await page.getByText('1 Hour', { exact: true }).click()
  await expect.poll(() => call<number>('getAutoLockTimeId')).toBe(6)

  // Testnet4: the home screen can re-render under the network list.
  await goTo(extension, page, '/main')
  await home.waitUntilReady()
  await expect(async () => {
    if ((await call<string>('getChainType')) !== 'QBIT_TESTNET4') {
      const bar = page.getByTestId('switch-network-bar')
      if (!(await bar.isVisible())) await goTo(extension, page, '/main')
      const testnet = page.getByTestId('chain-item-QBIT_TESTNET4')
      if (!(await testnet.isVisible())) await bar.click({ timeout: 10_000 })
      await testnet.click({ timeout: 5_000 })
    }
    expect(await call<string>('getChainType')).toBe('QBIT_TESTNET4')
  }).toPass({ timeout: 120_000 })

  // A second account, selected.
  await goTo(extension, page, '/account/switch-account')
  await page.getByTestId('new-account-button').click()
  await page.getByTestId('create-account-name-input').fill(SECOND_ACCOUNT_NAME)
  await page.getByTestId('create-account-confirm-button').click()
  await home.waitUntilReady()
  await expect
    .poll(async () => (await call<AccountProbe>('getCurrentAccount')).alianName)
    .toBe(SECOND_ACCOUNT_NAME)
  const savings = await call<AccountProbe>('getCurrentAccount')

  // A contact: the first testnet account of the public test phrase.
  const contactWallet = await call<KeyringProbe>('createTmpKeyringWithMnemonics', [
    FIXED_MNEMONIC.join(' '),
    QBIT_TESTNET4_HD_PATH,
    '',
    P2MR,
    1,
  ])
  const contactAddress = contactWallet.accounts[0]!.address
  await goTo(extension, page, '/settings/contacts/edit')
  await page.getByPlaceholder('Enter name').fill(CONTACT_NAME)
  await page.getByPlaceholder('Enter address').fill(contactAddress)
  await page.getByText('Save', { exact: true }).click()
  await expect
    .poll(async () => (await call<ContactProbe[]>('listContacts')).map(item => item.name))
    .toContain(CONTACT_NAME)

  // A connected site, approved in the release's own popup.
  const dapp = await extension.context.newPage()
  await dapp.goto(origin, { waitUntil: 'domcontentloaded' })
  await dapp.waitForFunction(() => Boolean((window as { qbit?: unknown }).qbit))
  const connected = dapp.evaluate(() =>
    (window as unknown as { qbit: { requestAccounts(): Promise<string[]> } }).qbit.requestAccounts()
  )
  const approval = await ApprovalsPage.waitForNext(extension.context)
  await approval.approveConnection()
  expect(await connected).toEqual([savings.address])
  await dapp.close()

  // Dark theme, and a half-written send left in the saved screen state.
  await goTo(extension, page, '/settings/appearance')
  await page.getByTestId('appearance-option-dark').click()
  await expect.poll(() => call<string>('getThemeMode')).toBe('dark')
  await goTo(extension, page, '/main')
  await home.waitUntilReady()
  await home.openSend()
  const send = new SendPage(page)
  await send.waitForCreate()
  await send.enterTransfer(contactAddress, '0.0001')
  await goTo(extension, page, '/main')
  await home.waitUntilReady()

  const before = await snapshot(extension, page)
  // Both stores save about a second after a change; let every save land.
  await page.waitForTimeout(5_000)
  await page.goto('about:blank')
  return { before, savings, contactAddress }
}

for (const [release, sha256] of Object.entries(RELEASES)) {
  test(`Chrome update from ${release} to 1.0.8 keeps the wallet, and 1.0.8 runs on it`, async ({}, testInfo) => {
    test.skip(!RELEASES_DIR, 'QBIT_UPGRADE_RELEASES_DIR is not set; see README.md')
    const zip = join(RELEASES_DIR, `qbit-chrome-mv3-${release}.zip`)
    expect(existsSync(zip), `${zip} is missing`).toBe(true)
    expect(
      createHash('sha256')
        .update(await readFile(zip))
        .digest('hex'),
      `${zip} hash`
    ).toBe(sha256)
    const targetManifest = JSON.parse(await readFile(join(TARGET_DIR, 'manifest.json'), 'utf8'))

    // The installed directory: the release first, then 1.0.8 in its place.
    const slot = testInfo.outputPath('extension')
    await rm(slot, { recursive: true, force: true })
    await mkdir(slot, { recursive: true })
    execFileSync('unzip', ['-q', zip, '-d', slot])
    const releaseManifest = JSON.parse(await readFile(join(slot, 'manifest.json'), 'utf8'))
    expect(`v${releaseManifest.version}`).toBe(release)

    const server = new DappServer()
    const origin = await server.start()
    const extension = new ExtensionSession(testInfo.outputPath('profile'), undefined, {
      browserArgs: OFFLINE_BROWSER_ARGS,
      extensionDir: slot,
    })
    const pageErrors: string[] = []
    try {
      await extension.start()
      const releaseId = extension.extensionId
      const { before, savings, contactAddress } = await setUpRelease(extension, origin)
      await extension.close()

      // The update: same directory, same profile, new version.
      await rm(slot, { recursive: true, force: true })
      await cp(TARGET_DIR, slot, { recursive: true })
      // Chrome keeps the release's service worker script in the profile and,
      // for an unpacked directory replaced while it was closed, starts it
      // with no listeners. A Web Store update registers the new script, so
      // drop that copy, and only that: the wallet's data stays in Local
      // Extension Settings and Local Storage.
      await rm(join(testInfo.outputPath('profile'), 'Default', 'Service Worker'), {
        recursive: true,
        force: true,
      })
      await extension.start()
      expect(extension.extensionId).toBe(releaseId)
      extension.context.on('page', page =>
        page.on('pageerror', error => pageErrors.push(error.message))
      )

      const page = await extension.openWallet('/main')
      page.on('pageerror', error => pageErrors.push(error.message))
      const manifest = await page.evaluate(() => chrome.runtime.getManifest())
      expect(manifest.version).toBe(targetManifest.version)
      expect(manifest.permissions).toContain('idle')

      // A browser restart leaves the wallet locked; the release's password opens it.
      const settings = new SettingsPage(page)
      await settings.unlock(PASSWORD)
      const home = new WalletHomePage(page)
      await home.waitUntilReady()
      expect(await snapshot(extension, page)).toEqual(before)

      // The new lock settings are on for a wallet stored before they existed.
      expect(await extension.requestWalletController(page, 'getLockOnComputerLock')).toBe(true)
      expect(await extension.requestWalletController(page, 'getLockOnWindowsClosed')).toBe(true)
      await goTo(extension, page, '/settings/advanced')
      await expect(page.getByText('Lock when the computer locks', { exact: true })).toBeVisible()
      await expect(page.getByText('Lock when all windows close', { exact: true })).toBeVisible()

      // The send screen opens on the release's saved screen state.
      await goTo(extension, page, '/main')
      await home.waitUntilReady()
      await home.openSend()
      await new SendPage(page).waitForCreate()
      await page.getByTestId('recipient-address-input').fill(contactAddress)
      await expect(page.getByTestId('recipient-address-input')).toHaveValue(contactAddress)

      // Receive keeps the selected account. Offline it cannot tell a used
      // address from an unused one, so it offers none and says so.
      await goTo(extension, page, '/main')
      await home.waitUntilReady()
      await home.openReceive()
      await expect(page.getByTestId('no-safe-receive-address')).toBeVisible()
      await expect(page.locator('.receive-address-button')).toHaveCount(0)
      expect(
        (await extension.requestWalletController<AccountProbe>(page, 'getCurrentAccount')).address
      ).toBe(savings.address)

      // The site connected in the release is still connected, with no new approval.
      const dapp = await extension.context.newPage()
      await dapp.goto(origin, { waitUntil: 'domcontentloaded' })
      await dapp.waitForFunction(() => Boolean((window as { qbit?: unknown }).qbit))
      expect(
        await dapp.evaluate(() =>
          (window as unknown as { qbit: { getAccounts(): Promise<string[]> } }).qbit.getAccounts()
        )
      ).toEqual([savings.address])

      // What 1.0.8 saved while it ran opens again after another restart.
      await extension.restart()
      const reopened = await extension.openWallet('/main')
      await new SettingsPage(reopened).unlock(PASSWORD)
      await new WalletHomePage(reopened).waitUntilReady()
      expect(await snapshot(extension, reopened)).toEqual(before)
      expect(pageErrors, 'uncaught errors in wallet pages').toEqual([])
    } finally {
      try {
        await extension.attachServiceWorkerLog(testInfo)
      } finally {
        await extension.close()
        await server.close()
      }
    }
  })
}
