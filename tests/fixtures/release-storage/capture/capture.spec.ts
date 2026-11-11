import { createECDH, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test'

import { ApprovalsPage, OnboardingPage, SendPage, WalletHomePage } from '../../../e2e/pages'
import { DappServer } from '../../../e2e/support/dapp-server'
import { FIXED_MNEMONIC } from '../../../e2e/support/wallet-setup'

/**
 * Drives one released build through the setup the README describes and
 * writes what it stored. Every value comes from that build's own code: the
 * wallet, its seed and its vault are created by the release, and the dumps
 * are read back from its storage.
 */

const RELEASE = process.env['QBIT_CAPTURE_RELEASE'] ?? ''
const EXTENSION_DIR = process.env['QBIT_CAPTURE_EXTENSION_DIR'] ?? ''
const RELEASE_ZIP = process.env['QBIT_CAPTURE_RELEASE_ZIP'] ?? ''
const PROFILE_DIR = process.env['QBIT_CAPTURE_PROFILE_DIR'] ?? ''

// Test-only: these fixtures are public and the wallets never hold funds.
const CAPTURE_PASSWORD = 'Qbit-Upgrade-Fixture-Only!1'
const P2MR = 9
const QBIT_TESTNET4_HD_PATH = "m/87'/1'/0'/0"
const SECOND_ACCOUNT_NAME = 'Savings'
const CONTACT_NAME = 'Fixture contact'
const LOCALE = 'es'
const LOCALE_NAME = 'Español'
const THEME_MODE = 'dark'
const AUTO_LOCK_LABEL = '1 Hour'
const EXTENSION_WORKER_URL = /^chrome-extension:\/\/([a-p]{32})\//

const outputDir = resolve(__dirname, '..', RELEASE.replace(/^v/, ''))

interface WalletAccountProbe {
  type: string
  pubkey: string
  address: string
  alianName: string
  index: number
}

interface WalletKeyringProbe {
  key: string
  index: number
  type: string
  alianName: string
  addressType: number
  accounts: WalletAccountProbe[]
}

interface ConnectedSiteProbe {
  origin: string
  chain: string
  isConnected: boolean
}

interface ContactProbe {
  name: string
  address: string
  chain: string
  isContact: boolean
  isAlias: boolean
}

function requireEnv(name: string, value: string): string {
  if (!value) throw new Error(`${name} is not set; see tests/fixtures/release-storage/README.md`)
  return value
}

async function callController<T>(
  page: Page,
  method: string,
  params: readonly unknown[] = []
): Promise<T> {
  return page.evaluate(
    ({ method, params }) =>
      new Promise<T>((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'tab' })
        const ident = 1
        const timeout = window.setTimeout(() => {
          port.disconnect()
          reject(new Error(`wallet controller request timed out: ${method}`))
        }, 120_000)
        port.onMessage.addListener(message => {
          if (message?._type_ !== 'QBIT_WALLET_response' || message?.data?.ident !== ident) return
          window.clearTimeout(timeout)
          port.disconnect()
          if (message.data.err) {
            reject(new Error(message.data.err.message || String(message.data.err)))
            return
          }
          resolve(message.data.res as T)
        })
        port.postMessage({
          _type_: 'QBIT_WALLET_request',
          data: { ident, data: { type: 'ui_controller', method, params } },
        })
      }),
    { method, params }
  )
}

async function launch(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...(process.env['QBIT_E2E_CHROMIUM_EXECUTABLE']
      ? { executablePath: process.env['QBIT_E2E_CHROMIUM_EXECUTABLE'] }
      : {}),
    headless: false,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 420, height: 860 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-default-browser-check',
      '--no-first-run',
      // Offline but for the loopback dApp: no explorer learns these wallets,
      // and nothing in the run depends on a public service.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  })
  const worker =
    context.serviceWorkers().find(candidate => EXTENSION_WORKER_URL.test(candidate.url())) ??
    (await context.waitForEvent('serviceworker', {
      predicate: candidate => EXTENSION_WORKER_URL.test(candidate.url()),
      timeout: 60_000,
    }))
  const extensionId = worker.url().match(EXTENSION_WORKER_URL)?.[1]
  if (!extensionId) throw new Error(`no extension id in ${worker.url()}`)
  return { context, extensionId }
}

async function goTo(page: Page, extensionId: string, route: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/index.html#${route}`, {
    waitUntil: 'domcontentloaded',
  })
}

async function currentKeyring(page: Page): Promise<WalletKeyringProbe> {
  return callController<WalletKeyringProbe>(page, 'getCurrentKeyring')
}

/**
 * Where the build lists wallets and accounts. Builds with the account
 * switcher list them in one sheet that the home screen's account card opens,
 * and the card names the wallet. Releases up to 1.0.8 list them on two
 * pages: the wallets behind the header's wallet chip, and the current
 * wallet's accounts behind the card.
 */
type AccountLists = 'switcher' | 'pages'

async function accountLists(page: Page): Promise<AccountLists> {
  const cardWalletName = page.getByTestId('account-select-wallet-name')
  const walletChip = page.getByTestId('wallet-management-entry')
  await expect(cardWalletName.or(walletChip).first()).toBeVisible()
  return (await cardWalletName.count()) > 0 ? 'switcher' : 'pages'
}

test('captures the storage a released build writes', async () => {
  test.setTimeout(15 * 60_000)
  requireEnv('QBIT_CAPTURE_RELEASE', RELEASE)
  requireEnv('QBIT_CAPTURE_EXTENSION_DIR', EXTENSION_DIR)
  requireEnv('QBIT_CAPTURE_RELEASE_ZIP', RELEASE_ZIP)
  requireEnv('QBIT_CAPTURE_PROFILE_DIR', PROFILE_DIR)
  if (existsSync(join(PROFILE_DIR, 'Default'))) {
    throw new Error(`${PROFILE_DIR} already holds a profile; captures start from a fresh one`)
  }
  const manifest = JSON.parse(await readFile(join(EXTENSION_DIR, 'manifest.json'), 'utf8'))
  if (`v${manifest.version}` !== RELEASE) {
    throw new Error(`${EXTENSION_DIR} holds ${manifest.version}, not ${RELEASE}`)
  }
  const zipSha256 = createHash('sha256')
    .update(await readFile(RELEASE_ZIP))
    .digest('hex')

  const { context, extensionId } = await launch()
  // Steps this build could not take, for wallet.json.
  const notes: string[] = []
  const server = new DappServer()
  try {
    // 1. A new wallet, with the seed the release generates.
    const page = await context.newPage()
    await goTo(page, extensionId, '/welcome')
    const words = await new OnboardingPage(page).createNewWallet(CAPTURE_PASSWORD)
    const home = new WalletHomePage(page)
    await home.waitUntilReady()

    // 2. A longer auto-lock first, as the default (3 minutes) would lock the
    //    wallet during this run. A non-default network.
    await goTo(page, extensionId, '/settings/lock-time')
    await page.getByText(AUTO_LOCK_LABEL, { exact: true }).click()
    await expect.poll(() => callController<number>(page, 'getAutoLockTimeId')).toBe(6)
    await goTo(page, extensionId, '/main')
    await home.waitUntilReady()
    // The home screen can re-render under the network list as it loads, and
    // can stay blank after the switch until it is opened again.
    await expect(async () => {
      if ((await callController<string>(page, 'getChainType')) !== 'QBIT_TESTNET4') {
        const bar = page.getByTestId('switch-network-bar')
        if (!(await bar.isVisible())) await goTo(page, extensionId, '/main')
        const testnet = page.getByTestId('chain-item-QBIT_TESTNET4')
        if (!(await testnet.isVisible())) await bar.click({ timeout: 10_000 })
        await testnet.click({ timeout: 5_000 })
      }
      expect(await callController<string>(page, 'getChainType')).toBe('QBIT_TESTNET4')
    }).toPass({ timeout: 120_000 })
    await goTo(page, extensionId, '/main')
    await home.waitUntilReady()
    await expect(page.getByTestId('switch-network-bar')).toContainText('Testnet')

    // 3. A second, named account.
    const lists = await accountLists(page)
    if (lists === 'switcher') {
      const switcher = await home.openAccountSwitcher()
      await switcher.addAccount((await currentKeyring(page)).key)
    } else {
      await goTo(page, extensionId, '/account/switch-account')
      await page.getByTestId('new-account-button').click()
    }
    await page.getByTestId('create-account-name-input').fill(SECOND_ACCOUNT_NAME)
    await page.getByTestId('create-account-confirm-button').click()
    await home.waitUntilReady()
    const hdWallet = await currentKeyring(page)
    expect(hdWallet.accounts).toHaveLength(2)

    // 4. Developer mode, by tapping the version as a user does.
    await goTo(page, extensionId, '/settings/about-us')
    // Ten taps about 120 ms apart, well within the 500 ms the screen allows
    // between taps, as raw clicks: locator clicks can be slower than that on a
    // busy host, and taps sent back to back can turn the mode on and off again
    // in one round. A missed round is tapped again, but only once the mode is
    // known to be off, so it is never toggled twice.
    await expect(async () => {
      if (!(await callController<boolean>(page, 'getDeveloperMode'))) {
        const box = await page.getByText(/^Version:/).boundingBox({ timeout: 10_000 })
        if (!box) throw new Error('the version label is not visible')
        for (let tap = 0; tap < 10; tap += 1) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          await page.waitForTimeout(120)
        }
      }
      await expect
        .poll(() => callController<boolean>(page, 'getDeveloperMode'), { timeout: 10_000 })
        .toBe(true)
    }).toPass({ timeout: 90_000 })

    // 5. A readonly wallet, which this build offers in developer mode. Its
    //    public key is a fresh secp256k1 key whose private half is dropped.
    const readonlyPublicKey = createECDH('secp256k1').generateKeys('hex', 'compressed')
    // A hash change does not reload the app, and 1.0.5 reads the mode only
    // when it loads: reload, as reopening the popup does, then take the
    // user's path to the new-wallet screen.
    await expect(async () => {
      await goTo(page, extensionId, '/main')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await home.waitUntilReady()
      if (lists === 'switcher') {
        await home.openAddWallet()
      } else {
        await page.getByTestId('wallet-management-entry').click()
        await expect(page).toHaveURL(/#\/account\/switch-keyring(?:$|\?)/)
        await page.getByTestId('add-wallet-button').click()
      }
      await page.getByText('Readonly Wallet', { exact: true }).click({ timeout: 15_000 })
    }).toPass({ timeout: 120_000 })
    await page.getByTestId('readonly-public-key-input').fill(readonlyPublicKey)
    await page.getByTestId('readonly-public-key-continue-button').click()
    await page.getByTestId('readonly-address-type-card-0').click()
    await page.getByTestId('readonly-address-type-continue-button').click()
    await home.waitUntilReady()
    const readonlyWallet = await currentKeyring(page)
    expect(readonlyWallet.type).toBe('Readonly')

    // 6. Back to the mnemonic wallet's second account: one tap in the
    //    account switcher, or the wallet's page and then the account's.
    const savings = hdWallet.accounts[1]!
    if (lists === 'switcher') {
      await home.switchAccount(savings.address)
    } else {
      await goTo(page, extensionId, '/account/switch-keyring')
      await page.getByTestId(`wallet-item-${hdWallet.key}`).click()
      await home.waitUntilReady()
      await goTo(page, extensionId, '/account/switch-account')
      await page
        .getByTestId(`account-item-${savings.address}`)
        .getByText(`${savings.address.slice(0, 8)}...${savings.address.slice(-8)}`, {
          exact: true,
        })
        .click()
      await home.waitUntilReady()
    }
    await expect
      .poll(
        async () => (await callController<WalletAccountProbe>(page, 'getCurrentAccount')).address
      )
      .toBe(savings.address)

    // 7. A contact. Its address is the first testnet account of the public
    //    test mnemonic, read from this release without storing that wallet.
    const contactWallet = await callController<WalletKeyringProbe>(
      page,
      'createTmpKeyringWithMnemonics',
      [FIXED_MNEMONIC.join(' '), QBIT_TESTNET4_HD_PATH, '', P2MR, 1]
    )
    const contactAddress = contactWallet.accounts[0]!.address
    await goTo(page, extensionId, '/settings/contacts/edit')
    await page.getByPlaceholder('Enter name').fill(CONTACT_NAME)
    await page.getByPlaceholder('Enter address').fill(contactAddress)
    await page.getByText('Save', { exact: true }).click()
    await expect
      .poll(async () =>
        (await callController<ContactProbe[]>(page, 'listContacts')).map(item => item.name)
      )
      .toContain(CONTACT_NAME)

    // 8. A connected site, approved in the release's own popup.
    const origin = await server.start()
    const dapp = await context.newPage()
    await dapp.goto(origin, { waitUntil: 'domcontentloaded' })
    await dapp.waitForFunction(() => Boolean((window as { qbit?: unknown }).qbit))
    const connected = dapp.evaluate(() =>
      (
        window as unknown as { qbit: { requestAccounts(): Promise<string[]> } }
      ).qbit.requestAccounts()
    )
    const approval = await ApprovalsPage.waitForNext(context)
    await expect(approval.page.getByTestId('connect-account-item')).toContainText(
      SECOND_ACCOUNT_NAME
    )
    await approval.approveConnection()
    expect(await connected).toEqual([savings.address])
    await dapp.close()

    // 9. A non-default theme.
    await goTo(page, extensionId, '/settings/appearance')
    await page.getByTestId(`appearance-option-${THEME_MODE}`).click()
    await expect.poll(() => callController<string>(page, 'getThemeMode')).toBe(THEME_MODE)

    // 10. Saved UI state: a collapsed balance card, hidden balances and a
    //     half-written send. From 1.0.6 the card has no breakdown to show,
    //     and does not collapse, until a balance loads, which it never does
    //     offline: the capture then records that it could not collapse it.
    await goTo(page, extensionId, '/main')
    await home.waitUntilReady()
    await expect(home.balanceCard.getByTestId('balance-loading')).toHaveCount(0, {
      timeout: 60_000,
    })
    const collapsible = (await home.balanceCard.getByTestId('balance-error').count()) === 0
    if (!collapsible) {
      notes.push(
        'Step 10: the balance card was not collapsed. This build collapses it only once a balance loads, and none loads offline.'
      )
    }
    await home.balanceCard.click()
    await home.balanceCard.locator('[src*="balance-eyes"], [style*="balance-eyes"]').click()
    await expect(
      home.balanceCard.locator('[src*="balance-eyes-closed"], [style*="balance-eyes-closed"]')
    ).toBeVisible()
    await home.openSend()
    const send = new SendPage(page)
    await send.waitForCreate()
    await send.enterTransfer(contactAddress, '0.0001')
    await goTo(page, extensionId, '/main')
    await home.waitUntilReady()

    // 11. The language last, as every label after it changes.
    await goTo(page, extensionId, '/settings/language')
    await page.getByText(LOCALE_NAME, { exact: true }).click()
    await expect.poll(() => callController<string>(page, 'getLocale')).toBe(LOCALE)

    // What the release reports, read before the dump.
    const keyrings = await callController<WalletKeyringProbe[]>(page, 'getKeyrings')
    const currentAccount = await callController<WalletAccountProbe>(page, 'getCurrentAccount')
    const sites = await callController<ConnectedSiteProbe[]>(page, 'getConnectedSites')
    const contacts = await callController<ContactProbe[]>(page, 'listContacts')
    const settings = {
      chainType: await callController<string>(page, 'getChainType'),
      locale: await callController<string>(page, 'getLocale'),
      themeMode: await callController<string>(page, 'getThemeMode'),
      autoLockTimeId: await callController<number>(page, 'getAutoLockTimeId'),
      developerMode: await callController<boolean>(page, 'getDeveloperMode'),
    }

    // Both stores save a second after a change; let every save land.
    await page.waitForTimeout(5_000)
    const localStorageDump = await page.evaluate(() => {
      const entries: Record<string, string> = {}
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (key !== null) entries[key] = localStorage.getItem(key) ?? ''
      }
      return entries
    })
    const storageDump = await page.evaluate(() => chrome.storage.local.get(null))
    const userAgent = await page.evaluate(() => navigator.userAgent)

    const savedUi = JSON.parse(localStorageDump['redux_localstorage_simple_ui'] ?? '{}')
    expect(savedUi.balanceDetailExpanded, 'the balance card is expanded').toBe(!collapsible)

    await mkdir(outputDir, { recursive: true })
    const write = (name: string, value: unknown) =>
      writeFile(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`)
    await write('chrome-storage-local.json', storageDump)
    await write('local-storage.json', localStorageDump)
    await write('wallet.json', {
      release: RELEASE,
      zip: { name: RELEASE_ZIP.split('/').pop(), sha256: zipSha256 },
      extensionVersion: manifest.version,
      userAgent,
      testOnly: true,
      password: CAPTURE_PASSWORD,
      mnemonic: words.join(' '),
      readonlyPublicKey,
      keyrings: keyrings.map(keyring => ({
        type: keyring.type,
        alianName: keyring.alianName,
        addressType: keyring.addressType,
        accounts: keyring.accounts.map(account => ({
          address: account.address,
          pubkey: account.pubkey,
          alianName: account.alianName,
        })),
      })),
      currentAccount: { address: currentAccount.address, alianName: currentAccount.alianName },
      contacts: contacts.filter(contact => contact.isContact),
      connectedSites: sites.map(site => ({
        origin: site.origin,
        chain: site.chain,
        isConnected: site.isConnected,
      })),
      settings,
      ...(notes.length > 0 ? { notes } : {}),
    })
  } finally {
    await server.close()
    await context.close()
  }
})
