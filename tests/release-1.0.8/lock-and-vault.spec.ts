import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { test as base, expect, type Page } from '@playwright/test'

import { OnboardingPage, SettingsPage, WalletHomePage } from '../e2e/pages'
import { ExtensionSession } from '../e2e/support/extension-session'
import { repositoryRoot } from '../e2e/support/paths'
import { OFFLINE_BROWSER_ARGS } from '../e2e/support/release-storage'

/**
 * 1.0.8 lock and vault behaviour a browser can show without a regtest node:
 * the Security switches and what turning one off does (#150), a lock that
 * arrives while an unlock runs (#150), and a vault entry of a type this
 * build does not know (#135). Locking the computer cannot be triggered from
 * a test: Chrome reports it only from the operating system.
 */

const PASSWORD = 'Qbit-Lock-Test-Only!1'
const LOCKED_DURING_UNLOCK = 'The wallet locked while unlocking. Unlock it again.'

// The same encryptor the keyring service uses for the vault.
const passworder = createRequire(resolve(repositoryRoot, 'packages/keyring-service/package.json'))(
  '@metamask/browser-passworder'
) as {
  encrypt(password: string, data: unknown): Promise<string>
  decrypt(password: string, vault: string): Promise<unknown>
}

const test = base.extend<{ extension: ExtensionSession }>({
  extension: async ({}, use, testInfo) => {
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const extension = new ExtensionSession(userDataDir, undefined, {
      browserArgs: OFFLINE_BROWSER_ARGS,
    })
    await extension.start()
    try {
      await use(extension)
    } finally {
      try {
        await extension.attachServiceWorkerLog(testInfo)
      } finally {
        await extension.close()
      }
    }
  },
})

async function onboard(extension: ExtensionSession): Promise<Page> {
  const page = await extension.openWallet('/welcome')
  await new OnboardingPage(page).createNewWallet(PASSWORD)
  await new WalletHomePage(page).waitUntilReady()
  return page
}

const isUnlocked = (extension: ExtensionSession, page: Page) =>
  extension.requestWalletController<boolean>(page, 'isUnlocked')

/** A wallet page in a popup window, which does not count as an open browser window. */
async function openPopup(extension: ExtensionSession, from: Page): Promise<Page> {
  const opened = extension.context.waitForEvent('page')
  await from.evaluate(async () => {
    await chrome.windows.create({ type: 'popup', url: chrome.runtime.getURL('index.html#/main') })
  })
  const popup = await opened
  await popup.waitForLoadState('domcontentloaded')
  return popup
}

async function closeNormalWindows(extension: ExtensionSession, keep: Page) {
  for (const page of extension.context.pages()) if (page !== keep) await page.close()
}

test('Security switches: both are on by default, save, and "Lock when all windows close" off keeps the wallet unlocked', async ({
  extension,
}) => {
  const page = await onboard(extension)
  expect(await extension.requestWalletController(page, 'getLockOnComputerLock')).toBe(true)
  expect(await extension.requestWalletController(page, 'getLockOnWindowsClosed')).toBe(true)

  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/settings/advanced`)
  const computerRow = page.getByTestId('lock-on-computer-lock-row')
  const windowsRow = page.getByTestId('lock-on-windows-closed-row')
  await expect(computerRow).toContainText('Lock when the computer locks')
  await expect(windowsRow).toContainText('Lock when all windows close')

  // Each switch saves, and the saved value survives a reload of the screen.
  await computerRow.locator(':scope > div').last().click()
  await expect
    .poll(() => extension.requestWalletController(page, 'getLockOnComputerLock'))
    .toBe(false)
  await windowsRow.locator(':scope > div').last().click()
  await expect
    .poll(() => extension.requestWalletController(page, 'getLockOnWindowsClosed'))
    .toBe(false)
  await page.reload()
  await expect(page.getByTestId('lock-on-windows-closed-row')).toBeVisible()
  expect(await extension.requestWalletController(page, 'getLockOnComputerLock')).toBe(false)
  expect(await extension.requestWalletController(page, 'getLockOnWindowsClosed')).toBe(false)

  // Off: closing every browser window leaves the wallet unlocked.
  const popup = await openPopup(extension, page)
  await closeNormalWindows(extension, popup)
  // Nothing signals that no lock is coming; give one time to arrive.
  await popup.waitForTimeout(5_000)
  expect(await isUnlocked(extension, popup)).toBe(true)

  // On again: closing every browser window locks it.
  const reopened = await extension.openWallet('/main')
  await new WalletHomePage(reopened).waitUntilReady()
  await extension.requestWalletController(reopened, 'setLockOnWindowsClosed', [true])
  await reopened.close()
  await expect.poll(() => isUnlocked(extension, popup), { timeout: 30_000 }).toBe(false)
})

test('a lock that arrives while an unlock runs wins, and the unlock screen says so', async ({
  extension,
}) => {
  const page = await onboard(extension)
  const other = await extension.openWallet('/main')
  await extension.requestWalletController(page, 'lockWallet')
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/account/unlock`)

  // The race needs the lock to land during the unlock's key derivation, which
  // takes about a second; try a few times.
  let sawMessage = false
  for (let attempt = 0; attempt < 5 && !sawMessage; attempt += 1) {
    const settings = new SettingsPage(page)
    await settings.waitForUnlock()
    await settings.unlockPasswordInput.fill(PASSWORD)
    await page.getByTestId('unlock-button').click()
    await extension.requestWalletController(other, 'lockWallet')
    const outcome = await Promise.race([
      page
        .getByText(LOCKED_DURING_UNLOCK, { exact: true })
        .waitFor({ timeout: 15_000 })
        .then(() => 'message' as const),
      page.waitForURL(/#\/main/, { timeout: 15_000 }).then(() => 'unlocked' as const),
    ])
    if (outcome === 'message') {
      sawMessage = true
      expect(await isUnlocked(extension, other)).toBe(false)
      await expect(page.getByText('Password is incorrect', { exact: true })).toHaveCount(0)
    } else {
      // The unlock finished before the lock: lock and try again.
      await extension.requestWalletController(other, 'lockWallet')
      await page.goto(`chrome-extension://${extension.extensionId}/index.html#/account/unlock`)
    }
  }
  expect(sawMessage, 'the lock never landed during an unlock in 5 tries').toBe(true)

  // The next unlock works.
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/account/unlock`)
  await new SettingsPage(page).unlock(PASSWORD)
  await new WalletHomePage(page).waitUntilReady()
})

test('a vault entry of a type this build does not know: the wallet unlocks, lists it as Unsupported Wallet, and keeps it', async ({
  extension,
}) => {
  const page = await onboard(extension)
  const before = await extension.requestWalletController<{ address: string }>(
    page,
    'getCurrentAccount'
  )
  await extension.requestWalletController(page, 'lockWallet')

  // Add an entry of an unknown type in front of the wallet, as a later
  // build, or an earlier one that shipped another keyring type, could leave.
  const futureEntry = { type: 'Future Keyring Type', data: { kept: 'exactly as stored' } }
  const { keyringState } = (await page.evaluate(() =>
    chrome.storage.local.get('keyringState')
  )) as {
    keyringState: { vault: string }
  }
  const entries = (await passworder.decrypt(PASSWORD, keyringState.vault)) as unknown[]
  const vault = await passworder.encrypt(PASSWORD, [futureEntry, ...entries])
  await page.evaluate(async ({ state }) => chrome.storage.local.set({ keyringState: state }), {
    state: { ...keyringState, vault },
  })
  await page.goto('about:blank')
  await extension.restart()

  const reopened = await extension.openWallet('/main')
  await new SettingsPage(reopened).unlock(PASSWORD)
  await new WalletHomePage(reopened).waitUntilReady()
  const keyrings = await extension.requestWalletController<
    { type: string; alianName: string; accounts: unknown[] }[]
  >(reopened, 'getKeyrings')
  expect(keyrings.map(keyring => keyring.type)).toContain('Future Keyring Type')
  const unsupported = keyrings.find(keyring => keyring.type === 'Future Keyring Type')!
  expect(unsupported.alianName).toMatch(/^Unsupported Wallet #\d+$/)
  expect(unsupported.accounts).toEqual([])
  expect(
    (await extension.requestWalletController<{ address: string }>(reopened, 'getCurrentAccount'))
      .address
  ).toBe(before.address)
  await reopened.goto(
    `chrome-extension://${extension.extensionId}/index.html#/account/switch-keyring`
  )
  await expect(reopened.getByText(unsupported.alianName, { exact: true })).toBeVisible()

  // A vault write (a new account) keeps the unknown entry exactly as stored.
  await reopened.goto(
    `chrome-extension://${extension.extensionId}/index.html#/account/switch-account`
  )
  await reopened.getByTestId('new-account-button').click()
  await reopened.getByTestId('create-account-name-input').fill('Second')
  await reopened.getByTestId('create-account-confirm-button').click()
  await new WalletHomePage(reopened).waitUntilReady()
  const after = (await reopened.evaluate(() => chrome.storage.local.get('keyringState'))) as {
    keyringState: { vault: string }
  }
  const stored = (await passworder.decrypt(PASSWORD, after.keyringState.vault)) as unknown[]
  expect(stored[0]).toEqual(futureEntry)
  expect(stored).toHaveLength(entries.length + 1)
})
