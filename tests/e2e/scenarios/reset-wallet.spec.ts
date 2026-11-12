import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  test as base,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test'

import { walletColorForSlot } from '../../../packages/wallet-shared/src/utils/wallet-identity'
import {
  ApprovalsPage,
  OnboardingPage,
  RecoveryReportPage,
  ResetWalletDialog,
  SettingsPage,
  WalletHomePage,
} from '../pages'
import {
  connectRecordingSite,
  readAccounts,
  recordedEvents,
  requestAccounts,
} from '../support/dapp-provider'
import { DappServer } from '../support/dapp-server'
import { holdBroadcasts, installBroadcastGate, releaseBroadcasts } from '../support/broadcast-gate'
import { EmptyRegtestExplorer } from '../support/empty-regtest-explorer'
import { ExtensionSession } from '../support/extension-session'
import { closeInstallTab } from '../support/install-tab'
import { assertRepositoryRoot, extensionDist } from '../support/paths'
import { E2E_PASSWORD, E2E_WRONG_PASSWORD, FIXED_MNEMONIC } from '../support/wallet-setup'

interface AccountProbe {
  address: string
  alianName: string
}

interface KeyringProbe {
  key: string
  index: number
  alianName: string
  color: string
  accounts: AccountProbe[]
}

interface ContactProbe {
  name: string
  address: string
}

interface SiteProbe {
  origin: string
}

/** The password of the wallet made after a reset. */
const NEW_PASSWORD = 'Qbit-E2E-After-Reset!42'
// What the reset must not leave behind: names, a color and a contact.
const OLD_WALLET_NAME = 'Rainy-day fund'
const OLD_ACCOUNT_NAME = 'Everyday'
const OLD_WALLET_COLOR = 'pink'
const OLD_CONTACT = {
  name: 'Reset contact',
  // The P2MR test vector of program 0x00..0x1f: no wallet here owns it.
  address: 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny',
  chain: 'QBIT_REGTEST',
  isContact: true,
}
const LAST_WALLET_TOAST = 'Removing the last wallet is not allowed'
/**
 * What the background answers a wallet page's call that waited for a reset
 * once that reset erased the wallets. Not expected on screen or as an error:
 * the pages reload on WALLET_RESET.
 */
const RESET_REFUSAL = 'Qbit Wallet was reset before this request ran, so it did not run'
const SHOWN_PREFIX = '[e2e] shown:'

/** In each wallet page, logs any text it shows that carries `refusal`, such as a toast. */
function watchShownRefusals({ refusal, prefix }: { refusal: string; prefix: string }): void {
  if (location.protocol !== 'chrome-extension:') return
  const reported = new Set<string>()
  new MutationObserver(records => {
    for (const record of records) {
      const nodes =
        record.type === 'characterData' ? [record.target] : Array.from(record.addedNodes)
      for (const node of nodes) {
        const text = (node.textContent ?? '').trim()
        if (text.includes(refusal) && !reported.has(text)) {
          reported.add(text)
          console.warn(`${prefix} ${text}`)
        }
      }
    }
  }).observe(document, { childList: true, subtree: true, characterData: true })
}

/**
 * The errors the wallet logs while a scenario runs: uncaught errors and console
 * errors of its pages, the reset refusal on any page's screen, and console
 * errors of its service worker. A scenario passes only when there are none.
 * Other console lines that mention the reset refusal are kept as notes.
 */
class WalletErrorLog {
  readonly entries: string[] = []
  readonly notes: string[] = []
  private readonly watched = new WeakSet<Page | Worker>()

  observeContext(context: BrowserContext): void {
    const watchPage = (page: Page) => {
      if (this.watched.has(page)) return
      this.watched.add(page)
      page.on('pageerror', error => this.recordPage(page, 'uncaught', error.message))
      page.on('console', message => {
        const text = message.text()
        if (message.type() === 'error') this.recordPage(page, 'console', text)
        else if (text.startsWith(SHOWN_PREFIX)) this.recordPage(page, 'shown', text)
        else if (text.includes(RESET_REFUSAL) && page.url().startsWith('chrome-extension://')) {
          this.notes.push(`console ${message.type()} in ${page.url()}: ${text}`)
        }
      })
    }
    const watchWorker = (worker: Worker) => {
      if (this.watched.has(worker) || !worker.url().startsWith('chrome-extension://')) return
      this.watched.add(worker)
      worker.on('console', message => {
        const text = message.text()
        if (message.type() === 'error') this.entries.push(`service worker: ${text}`)
        else if (text.includes(RESET_REFUSAL))
          this.notes.push(`service worker ${message.type()}: ${text}`)
      })
    }
    context.on('page', watchPage)
    context.pages().forEach(watchPage)
    context.on('serviceworker', watchWorker)
    context.serviceWorkers().forEach(watchWorker)
  }

  private recordPage(page: Page, kind: string, text: string): void {
    // Only the wallet's own pages: a dapp page's errors are not the wallet's.
    if (page.url().startsWith('chrome-extension://')) {
      this.entries.push(`${kind} in ${page.url()}: ${text}`)
    }
  }
}

// Needs no regtest node: the wallets live on Regtest, whose indexer is a
// loopback stand-in for a chain on which no address has any activity, and the
// dapp page is a loopback fixture the browser may reach.
const test = base.extend<{
  explorer: EmptyRegtestExplorer
  dapp: DappServer
  extension: ExtensionSession
}>({
  // Playwright reads a fixture's dependencies from this pattern; this one has none.
  // eslint-disable-next-line no-empty-pattern
  explorer: async ({}, use, testInfo) => {
    const explorer = new EmptyRegtestExplorer()
    await explorer.start()
    try {
      await use(explorer)
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach('empty-regtest-explorer.log', {
            body: explorer.log(),
            contentType: 'text/plain',
          })
        }
      } finally {
        await explorer.close()
      }
    }
  },
  // eslint-disable-next-line no-empty-pattern
  dapp: async ({}, use) => {
    const dapp = new DappServer()
    await dapp.start()
    try {
      await use(dapp)
    } finally {
      await dapp.close()
    }
  },
  extension: async ({ explorer, dapp }, use, testInfo) => {
    assertRepositoryRoot()
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const errors = new WalletErrorLog()
    const extension = new ExtensionSession(userDataDir, errors, {
      browserArgs: explorer.browserArgsReaching([dapp.origin]),
    })
    await extension.start()
    await extension.context.addInitScript(watchShownRefusals, {
      refusal: RESET_REFUSAL,
      prefix: SHOWN_PREFIX,
    })
    let failed = true
    try {
      await use(extension)
      failed = errors.entries.length > 0
      expect(errors.entries, 'errors the wallet logged').toEqual([])
    } finally {
      try {
        if (errors.notes.length) {
          await testInfo.attach('reset-refusal-notes.log', {
            body: `${errors.notes.join('\n')}\n`,
            contentType: 'text/plain',
          })
        }
        if (failed || testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach('wallet-errors.log', {
            body: errors.entries.length ? `${errors.entries.join('\n')}\n` : '(none)\n',
            contentType: 'text/plain',
          })
          await extension.attachServiceWorkerLog(testInfo)
        }
      } finally {
        await extension.close()
      }
    }
  },
})

/** One message of the build's copy in a language, by its key. */
type Copy = (key: string) => string

/** The build's copy in `locale`, as the wallet shows it. */
async function copyIn(locale: string): Promise<Copy> {
  const path = resolve(extensionDist, '_locales', locale, 'messages.json')
  const messages = JSON.parse(await readFile(path, 'utf8')) as Record<string, { message: string }>
  return key => {
    const message = messages[key]?.message
    if (message === undefined) throw new Error(`the ${locale} copy has no message ${key}`)
    return message
  }
}

async function walletKeyrings(extension: ExtensionSession, page: Page): Promise<KeyringProbe[]> {
  return extension.requestWalletController<KeyringProbe[]>(page, 'getKeyrings')
}

async function currentAddress(extension: ExtensionSession, page: Page): Promise<string> {
  return (await extension.requestWalletController<AccountProbe>(page, 'getCurrentAccount')).address
}

/** Whether the background holds a wallet, as a first-run check reads it. */
async function walletPresence(extension: ExtensionSession, page: Page) {
  return {
    isBooted: await extension.requestWalletController<boolean>(page, 'isBooted'),
    hasVault: await extension.requestWalletController<boolean>(page, 'hasVault'),
    isUnlocked: await extension.requestWalletController<boolean>(page, 'isUnlocked'),
  }
}

async function contactNames(extension: ExtensionSession, page: Page): Promise<string[]> {
  return (await extension.requestWalletController<ContactProbe[]>(page, 'listContacts')).map(
    contact => contact.name
  )
}

async function connectedOrigins(extension: ExtensionSession, page: Page): Promise<string[]> {
  return (await extension.requestWalletController<SiteProbe[]>(page, 'getConnectedSites')).map(
    site => site.origin
  )
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox()
  if (!bounds) throw new Error(`${locator} is not visible`)
  return bounds
}

async function goBack(page: Page): Promise<void> {
  await page.getByTestId('header-back-button').click()
}

/**
 * One wallet, "Wallet 1", made at onboarding and then moved to Regtest; the
 * tab the extension opened on install is closed.
 */
async function onboardWallet(extension: ExtensionSession) {
  const page = await extension.openWallet('/welcome')
  const onboarding = new OnboardingPage(page)
  const words = await onboarding.createNewWallet(E2E_PASSWORD)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await closeInstallTab(extension, page)
  const initialChain = await extension.requestWalletController<string>(page, 'getChainType')
  await home.switchToRegtest()
  const [keyring, ...others] = await walletKeyrings(extension, page)
  if (!keyring || others.length > 0) throw new Error('expected the one wallet onboarding made')
  const address = keyring.accounts[0]!.address
  await home.expectCurrentAccount({ walletName: 'Wallet 1', accountName: 'Account 1', address })
  return { page, home, onboarding, words, keyring, address, initialChain }
}

/** Adds "Wallet 2", restored from the public test phrase; it becomes current. */
async function restoreSecondWallet(
  extension: ExtensionSession,
  page: Page,
  first: KeyringProbe
): Promise<KeyringProbe> {
  const home = new WalletHomePage(page)
  await home.openAddWallet()
  await new OnboardingPage(page).restoreAdditionalWallet(FIXED_MNEMONIC)
  const report = new RecoveryReportPage(page)
  expect(await report.summary()).toEqual({ accountsRestored: 1, network: 'Regtest' })
  await report.continueToWallet()
  await home.waitUntilReady()
  const restored = (await walletKeyrings(extension, page)).find(
    keyring => keyring.key !== first.key
  )
  if (!restored) throw new Error('the restored wallet is not listed')
  await home.expectCurrentAccount({
    walletName: 'Wallet 2',
    address: restored.accounts[0]!.address,
  })
  return restored
}

test('reset wallet: Settings → Security erases the wallet and keeps only the language and the theme', async ({
  extension,
}) => {
  const en = await copyIn('en')
  const es = await copyIn('es')
  const { page, home, keyring, address, initialChain } = await onboardWallet(extension)

  // Leftovers a reset must erase: the wallet's and the account's names and
  // the wallet's color, and a contact.
  const sheet = await home.openAccountSwitcher()
  await sheet.renameWallet(keyring.key, OLD_WALLET_NAME)
  await sheet.renameAccount(address, OLD_ACCOUNT_NAME)
  await sheet.changeWalletColor(keyring.key, OLD_WALLET_COLOR)
  await sheet.close()
  await home.expectCurrentAccount({ walletName: OLD_WALLET_NAME, accountName: OLD_ACCOUNT_NAME })
  await extension.requestWalletController<void>(page, 'addContact', [OLD_CONTACT])
  expect(await contactNames(extension, page)).toEqual([OLD_CONTACT.name])

  // Settings lists Security directly above Appearance.
  await home.openSettings()
  const settings = new SettingsPage(page)
  await settings.waitUntilReady()
  const rows = await settings.items()
  expect(rows).toContain('security')
  expect(rows[rows.indexOf('security') + 1]).toBe('appearance')
  const securityRow = await box(settings.item('security'))
  const appearanceRow = await box(settings.item('appearance'))
  expect(securityRow.x).toBe(appearanceRow.x)
  expect(securityRow.y).toBeLessThan(appearanceRow.y)

  // Security offers exactly Change Password, Show Secret Recovery Phrase and
  // Reset Wallet, in that order.
  let security = await settings.openSecurity()
  await expect
    .poll(() => security.items())
    .toEqual(['changePassword', 'showSeedPhrase', 'resetWallet'])
  await expect(security.item('changePassword')).toHaveText(en('change_password'))
  await expect(security.item('showSeedPhrase')).toHaveText(en('show_secret_recovery_phrase'))
  await expect(security.item('resetWallet')).toHaveText(en('reset_wallet'))
  await goBack(page)
  await settings.waitUntilReady()

  // Advanced Settings no longer offers Change Password.
  await settings.openAdvanced()
  await expect(page.getByText(en('change_password'), { exact: true })).toHaveCount(0)
  await goBack(page)
  await settings.waitUntilReady()

  // The contact is in the address book.
  await settings.openAddressBook()
  await expect(page.getByText(OLD_CONTACT.name, { exact: true })).toBeVisible()
  await goBack(page)
  await settings.waitUntilReady()

  // What a reset keeps: the language, Spanish here, and the theme, dark here
  // (the default follows the system, which is light in this browser).
  await settings.expectTheme('light')
  await settings.chooseTheme('dark')
  await settings.chooseLanguage('Español')
  await expect(settings.item('security')).toHaveText(es('security'))
  expect(await extension.requestWalletController<string>(page, 'getLocale')).toBe('es')
  expect(await extension.requestWalletController<string>(page, 'getThemeMode')).toBe('dark')

  // Reset Wallet asks for the password before its button does anything.
  security = await settings.openSecurity()
  const reset = await security.openResetWallet()
  await expect(reset.passwordInput).toHaveValue('')
  await expect(reset.confirmButton).toHaveAttribute('aria-disabled', 'true')
  await expect(reset.confirmButton).toHaveCSS('cursor', 'not-allowed')
  await reset.enterPassword(E2E_WRONG_PASSWORD)
  await expect(reset.confirmButton).toHaveAttribute('aria-disabled', 'false')

  // A wrong password is refused under the field, and nothing is erased.
  await reset.confirmButton.click()
  await expect(reset.error).toHaveText(es('password_error'))
  await expect(reset.root).toBeVisible()
  expect(await walletPresence(extension, page)).toEqual({
    isBooted: true,
    hasVault: true,
    isUnlocked: true,
  })
  expect(await currentAddress(extension, page)).toBe(address)

  // The right password erases the wallet, and the page opens on Welcome.
  await reset.submit(E2E_PASSWORD)
  const onboarding = new OnboardingPage(page)
  await onboarding.waitForWelcome()
  expect(await walletPresence(extension, page)).toEqual({
    isBooted: false,
    hasVault: false,
    isUnlocked: false,
  })

  // Welcome is still in Spanish and dark.
  await expect(onboarding.createWalletButton).toHaveText(es('create_new_wallet'))
  await expect(onboarding.restoreWalletButton).toHaveText(es('i_already_have_a_wallet'))
  await settings.expectTheme('dark')
  expect(await extension.requestWalletController<string>(page, 'getLocale')).toBe('es')
  expect(await extension.requestWalletController<string>(page, 'getThemeMode')).toBe('dark')

  // A new wallet asks for a new password, not for the old one.
  await onboarding.chooseCreateWallet()
  await expect(onboarding.confirmPasswordInput).toBeVisible()
  await expect(settings.unlockPasswordInput).toHaveCount(0)
  await onboarding.createPassword(NEW_PASSWORD)
  await onboarding.acceptGeneratedMnemonic(await onboarding.readGeneratedMnemonic())
  await onboarding.submitAddressType()
  await home.waitUntilReady()

  // It starts afresh: its own default names and color, the default network,
  // and no contact.
  const [fresh, ...others] = await walletKeyrings(extension, page)
  expect(others).toEqual([])
  expect({
    name: fresh!.alianName,
    accounts: fresh!.accounts.map(account => account.alianName),
    color: fresh!.color,
  }).toEqual({ name: 'Wallet 1', accounts: ['Account 1'], color: walletColorForSlot(fresh!.index) })
  await home.expectCurrentAccount({ walletName: 'Wallet 1', accountName: 'Account 1' })
  await expect(home.cardWalletTile).toHaveAttribute('data-color', walletColorForSlot(fresh!.index))
  expect(await extension.requestWalletController<string>(page, 'getChainType')).toBe(initialChain)
  expect(await contactNames(extension, page)).toEqual([])
  await home.openSettings()
  await settings.openAddressBook()
  await expect(page.getByText(es('you_haven_t_added_any_addresses'), { exact: true })).toBeVisible()
  await expect(page.getByText(OLD_CONTACT.name, { exact: true })).toHaveCount(0)
  await goBack(page)

  // Locked, it opens with the new password, and the old one is refused.
  await settings.lockWallet()
  await settings.submitWrongPassword(E2E_PASSWORD, es('password_error'))
  await settings.unlock(NEW_PASSWORD)
  await home.waitUntilReady()
})

test('reset wallet: Remove Wallet on the last wallet in the account switcher opens the reset', async ({
  extension,
}) => {
  const { page, home, keyring: created, address } = await onboardWallet(extension)

  // With two wallets, Remove Wallet is the ordinary removal of that wallet.
  const restored = await restoreSecondWallet(extension, page, created)
  let sheet = await home.openAccountSwitcher()
  await sheet.removeWallet(restored.key)
  await expect(new ResetWalletDialog(page).root).toHaveCount(0)
  await expect.poll(() => sheet.walletKeys()).toEqual([created.key])
  expect(
    (await walletKeyrings(extension, page)).map(keyring => [keyring.key, keyring.accounts.length])
  ).toEqual([[created.key, 1]])
  expect(await currentAddress(extension, page)).toBe(address)

  // With one wallet left, Remove Wallet opens the reset dialog: no toast and
  // no removal popover. Cancel leaves the wallet as it was.
  let reset = await sheet.chooseRemoveOnLastWallet(created.key)
  await expect(page.getByText(LAST_WALLET_TOAST, { exact: true })).toHaveCount(0)
  await reset.cancel()
  await expect(sheet.root).toBeVisible()
  await expect.poll(() => sheet.walletKeys()).toEqual([created.key])
  expect(await walletPresence(extension, page)).toEqual({
    isBooted: true,
    hasVault: true,
    isUnlocked: true,
  })
  expect(await currentAddress(extension, page)).toBe(address)
  await sheet.close()
  await home.expectCurrentAccount({ walletName: 'Wallet 1', address })

  // Confirmed with the password, it resets the wallet.
  sheet = await home.openAccountSwitcher()
  reset = await sheet.chooseRemoveOnLastWallet(created.key)
  await reset.submit(E2E_PASSWORD)
  await new OnboardingPage(page).waitForWelcome()
  expect(await walletPresence(extension, page)).toEqual({
    isBooted: false,
    hasVault: false,
    isUnlocked: false,
  })
})

test('reset wallet: every wallet window and every connected site learns of it, and no site keeps the old account', async ({
  extension,
  dapp,
}) => {
  const en = await copyIn('en')
  const { page, home, address } = await onboardWallet(extension)

  // A site connected to the wallet, which records the events it is sent.
  const site = await connectRecordingSite(extension, dapp.origin)
  expect(await readAccounts(site)).toEqual([address])
  expect(await connectedOrigins(extension, page)).toEqual([dapp.origin])

  // A second wallet window, on the home screen.
  const other = await extension.openWallet('/main')
  const otherHome = new WalletHomePage(other)
  await otherHome.waitUntilReady()
  await otherHome.expectCurrentAccount({ walletName: 'Wallet 1', address })

  // Reset from the first window.
  await page.bringToFront()
  await home.openSettings()
  const settings = new SettingsPage(page)
  const reset = await (await settings.openSecurity()).openResetWallet()
  await reset.submit(E2E_PASSWORD)

  // The second window, left alone, opens on Welcome by itself, as does the
  // window that asked.
  await new OnboardingPage(other).waitForWelcome()
  const onboarding = new OnboardingPage(page)
  await onboarding.waitForWelcome()

  // The site is told it lost the account and was disconnected (the
  // disconnect also marks every earlier event delivered), and reads no
  // account any more.
  await expect
    .poll(() => recordedEvents(site).then(events => events.map(([event]) => event)))
    .toContain('disconnect')
  const disconnected = [
    ['accountsChanged', []],
    ['disconnect', expect.objectContaining({ code: 4900 })],
  ]
  expect(await recordedEvents(site)).toEqual(disconnected)
  expect(await readAccounts(site)).toEqual([])

  // The new wallet has no connected site, and tells the old one nothing.
  await onboarding.createNewWallet(NEW_PASSWORD)
  await home.waitUntilReady()
  expect(await connectedOrigins(extension, page)).toEqual([])
  await home.openSettings()
  await settings.openConnectedSites()
  await expect(page.getByText(en('no_connected_sites'), { exact: true })).toBeVisible()
  await expect(page.locator('[data-testid^="connected-site-"]')).toHaveCount(0)
  expect(await readAccounts(site)).toEqual([])
  expect(await recordedEvents(site)).toEqual(disconnected)

  // The site's next account request asks the user again, and is answered
  // with the new wallet's account once approved.
  const nextApproval = ApprovalsPage.waitForNext(extension.context)
  const answer = requestAccounts(site)
  const approval = await nextApproval
  expect(await approval.contextText()).toContain(dapp.origin)
  await approval.approveConnection()
  const newAddress = await currentAddress(extension, page)
  expect(newAddress).not.toBe(address)
  expect(await answer).toEqual([newAddress])
})

test("reset wallet: Security shows the current wallet's recovery phrase and changes the password", async ({
  extension,
}) => {
  const { page, home, words, keyring: created, address } = await onboardWallet(extension)
  await restoreSecondWallet(extension, page, created)

  // The phrase of the current wallet, the restored one, after the password.
  await home.openSettings()
  const settings = new SettingsPage(page)
  let security = await settings.openSecurity()
  let phrase = await security.openRecoveryPhrase()
  expect(await phrase.words()).toEqual([])
  expect(await phrase.reveal(E2E_PASSWORD, FIXED_MNEMONIC.length)).toEqual([...FIXED_MNEMONIC])

  // With the first wallet current, its own phrase.
  await goBack(page)
  await security.waitUntilReady()
  await goBack(page)
  await settings.waitUntilReady()
  await page.getByTestId('tab-home').click()
  await home.waitUntilReady()
  await home.switchAccount(address)
  await home.expectCurrentAccount({ walletName: 'Wallet 1' })
  await home.openSettings()
  security = await settings.openSecurity()
  phrase = await security.openRecoveryPhrase()
  expect(await phrase.words()).toEqual([])
  expect(await phrase.reveal(E2E_PASSWORD, words.length)).toEqual(words)
  await goBack(page)
  await security.waitUntilReady()

  // Change Password: its Back returns to Security, and the change holds.
  let changePassword = await security.openChangePassword()
  await changePassword.back()
  await security.waitUntilReady()
  changePassword = await security.openChangePassword()
  await changePassword.change(E2E_PASSWORD, NEW_PASSWORD)
  await home.waitUntilReady()
  await home.openSettings()
  await settings.lockWallet()
  await settings.submitWrongPassword(E2E_PASSWORD)
  await settings.unlock(NEW_PASSWORD)
  await home.waitUntilReady()
})

test('reset wallet: Remove Wallet reads the wallets again before it offers a reset', async ({
  extension,
}) => {
  await installBroadcastGate(extension.context)
  const { page, home, keyring: first } = await onboardWallet(extension)

  // Window 1: the account switcher, listing the only wallet.
  const sheet = await home.openAccountSwitcher()
  await expect.poll(() => sheet.walletKeys()).toEqual([first.key])

  // Window 2 adds a wallet, which window 1 has not heard of yet.
  await holdBroadcasts(page)
  const other = await extension.openWallet('/main')
  await new WalletHomePage(other).waitUntilReady()
  const added = await restoreSecondWallet(extension, other, first)
  const both = [first.key, added.key]
  expect(await sheet.walletKeys()).toEqual([first.key])

  // Remove Wallet in window 1 reads the wallets first: the wallet is not the
  // last one, so it is the ordinary removal, and the sheet lists both.
  await page.bringToFront()
  await sheet.chooseWalletMenuItem(first.key, 'remove')
  await expect(sheet.removalDialog).toBeVisible()
  await expect(new ResetWalletDialog(page).root).toHaveCount(0)
  await expect.poll(() => sheet.walletKeys()).toEqual(both)
  await sheet.cancelRemoval()
  await releaseBroadcasts(page)
  expect((await walletKeyrings(extension, page)).map(keyring => keyring.key)).toEqual(both)
})

test('reset wallet: a reset asked for as the last wallet erases nothing once another window adds a wallet', async ({
  extension,
}) => {
  const en = await copyIn('en')
  await installBroadcastGate(extension.context)
  const { page, home, keyring: first } = await onboardWallet(extension)

  // Window 1: the account switcher on the only wallet, whose Remove Wallet
  // opens the reset.
  const sheet = await home.openAccountSwitcher()
  const reset = await sheet.chooseRemoveOnLastWallet(first.key)

  // Window 2 adds a wallet meanwhile. Window 1 has not heard of it yet, so
  // its dialog stays open, and only the background can tell.
  await holdBroadcasts(page)
  const other = await extension.openWallet('/main')
  const otherHome = new WalletHomePage(other)
  await otherHome.waitUntilReady()
  const added = await restoreSecondWallet(extension, other, first)
  const both = [first.key, added.key]
  await expect(reset.root).toBeVisible()

  // Confirmed in window 1, the reset is refused: the wallet is no longer the
  // last one. The dialog closes with the reason, and nothing is erased.
  await page.bringToFront()
  await reset.submit(E2E_PASSWORD)
  await expect(page.getByText(en('wallet_reset_not_last_wallet'), { exact: true })).toBeVisible()
  await reset.waitUntilClosed()
  expect(await walletPresence(extension, page)).toEqual({
    isBooted: true,
    hasVault: true,
    isUnlocked: true,
  })
  expect((await walletKeyrings(extension, page)).map(keyring => keyring.key)).toEqual(both)
  await otherHome.waitUntilReady()

  // The switcher reads the wallets again, and Remove Wallet is now the
  // ordinary removal of that wallet.
  await expect.poll(() => sheet.walletKeys()).toEqual(both)
  await releaseBroadcasts(page)
  await sheet.chooseWalletMenuItem(first.key, 'remove')
  await expect(sheet.removalDialog).toBeVisible()
  await expect(reset.root).toHaveCount(0)
  await sheet.cancelRemoval()
  expect((await walletKeyrings(extension, page)).map(keyring => keyring.key)).toEqual(both)
})
