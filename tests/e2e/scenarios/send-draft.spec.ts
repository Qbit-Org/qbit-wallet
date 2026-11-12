import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/empty-regtest'
import {
  OnboardingPage,
  SendPage,
  SettingsPage,
  WalletHomePage,
  type Network,
  type SendDraft,
} from '../pages'
import type { ExtensionSession } from '../support/extension-session'
import { savedUi, stringsInLocalStorage, type SavedUi } from '../support/saved-ui'
import { E2E_PASSWORD } from '../support/wallet-setup'

// What the send form holds (recipient, amount, memo, replace-by-fee and the
// fee choice) stays in the page that shows it and never reaches the disk: the
// saved UI state holds the two display preferences only. A form left open
// starts again when the account or the network changes, in its own page or
// in another wallet window. None of these needs funds or a regtest node.

interface AccountProbe {
  address: string
  alianName: string
}

interface KeyringProbe {
  key: string
  accounts: AccountProbe[]
}

/**
 * The address-encoding test vector, the P2MR program of the bytes 0x00 to
 * 0x1f, as each network writes it: an address that no wallet owns.
 */
const UNOWNED_ADDRESS = {
  QBIT_MAINNET: 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw',
  QBIT_REGTEST: 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny',
} as const

/** A send form filled in on `network`, as the issue's reproduction filled it. */
function draftOn(network: keyof typeof UNOWNED_ADDRESS): SendDraft {
  return {
    recipient: UNOWNED_ADDRESS[network],
    amount: '0.00012345',
    memo: 'repro-memo',
    customFeeRate: '7.25',
  }
}

/** The text typed into the form, as it would appear in what a page saves. */
function typedText(draft: SendDraft): string[] {
  return [draft.recipient, draft.amount, draft.memo, draft.customFeeRate]
}

/** The saved UI state: the display preferences, the detail of the balance card never closed. */
function savedPreferences(isBalanceHidden: boolean) {
  return { isBalanceHidden, balanceDetailExpanded: true }
}

/**
 * A new wallet on `network`, open in one wallet page. The onboarding page and
 * the tab the install opened are closed, so that no other page writes the
 * saved UI state while a scenario reads it, and a page opened after
 * onboarding goes to the unlock screen when the wallet locks.
 */
async function newWallet(extension: ExtensionSession, network: Network) {
  const onboardingPage = await extension.openWallet('/welcome')
  await new OnboardingPage(onboardingPage).createNewWallet(E2E_PASSWORD)
  await new WalletHomePage(onboardingPage).waitUntilReady()
  const page = await extension.openWallet('/main')
  await Promise.all(
    extension.context
      .pages()
      .filter(open => open !== page)
      .map(open => open.close())
  )
  const home = new WalletHomePage(page)
  await home.switchNetwork(network)
  return { page, home, send: new SendPage(page) }
}

/** Adds a second account to the wallet, which makes it current. */
async function addAccount(extension: ExtensionSession, home: WalletHomePage) {
  const [wallet] = await extension.requestWalletController<KeyringProbe[]>(home.page, 'getKeyrings')
  await extension.requestWalletController(home.page, 'deriveNewAccountFromMnemonic', [
    wallet,
    'Savings',
  ])
  const [updated] = await extension.requestWalletController<KeyringProbe[]>(
    home.page,
    'getKeyrings'
  )
  const [first, added, ...others] = updated?.accounts ?? []
  if (!first || !added || others.length > 0) throw new Error('expected a wallet of two accounts')
  await home.expectCurrentAccount({ accountName: 'Savings', address: added.address })
  return { first, added }
}

async function currentAddress(extension: ExtensionSession, page: Page): Promise<string> {
  return (await extension.requestWalletController<AccountProbe>(page, 'getCurrentAccount')).address
}

/**
 * Hides or shows the balances on Home, and waits until the saved UI state
 * holds the change. A page writes that state as one value, so once the change
 * is on disk, so is anything else the page saves with it; on the build of
 * the issue, the form's values within a second of each change.
 */
async function savePreference(home: WalletHomePage, isBalanceHidden: boolean): Promise<void> {
  await home.setBalancesHidden(isBalanceHidden)
  await expect.poll(async () => (await savedUi(home.page))?.isBalanceHidden).toBe(isBalanceHidden)
}

/**
 * The saved UI state stays `expected` for three seconds, past the second after
 * a change at which a page saves. The build of the issue saved every page's
 * whole state a second after any change, so this caught a page writing its
 * older preferences over another page's.
 */
async function expectSavedUiKept(page: Page, expected: SavedUi): Promise<void> {
  const until = Date.now() + 3_000
  do {
    expect(await savedUi(page)).toEqual(expected)
    await page.waitForTimeout(250)
  } while (Date.now() < until)
  expect(await savedUi(page)).toEqual(expected)
}

/**
 * Turns replace-by-fee off in another window's own send form, which saves the
 * choice for the next form, and goes back to its Home.
 */
async function turnReplaceByFeeOff(other: WalletHomePage): Promise<void> {
  await other.openSend()
  const form = new SendPage(other.page)
  await form.setRbf(false)
  await form.back()
  await other.waitUntilReady()
}

test('send draft: nothing typed into the form is saved, before or after a lock', async ({
  extension,
}) => {
  const { page, home, send } = await newWallet(extension, 'QBIT_REGTEST')
  const draft = draftOn('QBIT_REGTEST')
  await home.openSend()
  await send.fillDraft(draft)
  await send.back()
  await home.waitUntilReady()

  await savePreference(home, true)
  expect(await savedUi(page)).toEqual(savedPreferences(true))
  expect(await stringsInLocalStorage(page, typedText(draft))).toEqual([])

  // Locked, the disk holds no more.
  await home.openSettings()
  const settings = new SettingsPage(page)
  await settings.lockWallet()
  expect(await savedUi(page)).toEqual(savedPreferences(true))
  expect(await stringsInLocalStorage(page, typedText(draft))).toEqual([])

  // Nor once unlocked: showing balances again saves the preferences only.
  await settings.unlock(E2E_PASSWORD)
  await home.waitUntilReady()
  await savePreference(home, false)
  expect(await savedUi(page)).toEqual(savedPreferences(false))
  expect(await stringsInLocalStorage(page, typedText(draft))).toEqual([])
})

test('send draft: after a restart and a network switch, the form opened by its route is empty, also after a reload', async ({
  extension,
}) => {
  test.setTimeout(4 * 60_000)
  const { page, home, send } = await newWallet(extension, 'QBIT_REGTEST')
  await home.openSend()
  await send.fillDraft(draftOn('QBIT_REGTEST'))
  await send.back()
  await home.waitUntilReady()
  await savePreference(home, true)
  await home.openSettings()
  await new SettingsPage(page).lockWallet()

  await extension.restart()
  const reopened = await extension.openWallet('/main')
  await new SettingsPage(reopened).unlock(E2E_PASSWORD)
  const reopenedHome = new WalletHomePage(reopened)
  await reopenedHome.waitUntilReady()
  // The display preference outlives the restart.
  expect(await reopenedHome.balancesHidden()).toBe(true)
  const regtestAddress = await currentAddress(extension, reopened)
  await reopenedHome.switchNetwork('QBIT_MAINNET')
  expect(await currentAddress(extension, reopened)).not.toBe(regtestAddress)

  // Not Send on Home, which starts a new form: a wallet tab on the form's route.
  const formPage = await extension.openWallet('/wallet/tx/create')
  const form = new SendPage(formPage)
  await form.expectEmpty()
  await formPage.reload()
  await form.expectEmpty()
})

test('send draft: reloading the tab on the form opens it empty', async ({ extension }) => {
  const { page, home, send } = await newWallet(extension, 'QBIT_REGTEST')
  const draft = draftOn('QBIT_REGTEST')
  await home.openSend()
  await send.fillDraft(draft)
  await send.back()
  await home.waitUntilReady()
  await savePreference(home, true)
  // The open page kept the values...
  await page.goForward()
  await send.expectDraft(draft)

  // ...which a new page on the same account and network does not have.
  await page.reload()
  await send.expectEmpty()
})

test('send draft: switching account in the page empties the form', async ({ extension }) => {
  const { page, home, send } = await newWallet(extension, 'QBIT_REGTEST')
  const { first } = await addAccount(extension, home)
  await home.openSend()
  await send.fillDraft(draftOn('QBIT_REGTEST'))
  await send.back()
  await home.waitUntilReady()

  await home.switchAccount(first.address)
  await page.goForward()
  await send.expectEmpty()
})

test('send draft: switching network in the page empties the form', async ({ extension }) => {
  // Filled in on Mainnet, whose rates this browser cannot read, and emptied
  // on Regtest, whose fee bar offers the stand-in's rates.
  const { page, home, send } = await newWallet(extension, 'QBIT_MAINNET')
  await home.openSend()
  await send.fillDraft(draftOn('QBIT_MAINNET'))
  await send.back()
  await home.waitUntilReady()

  await home.switchNetwork('QBIT_REGTEST')
  await page.goForward()
  await send.expectEmpty()
})

test('send draft: an account switch in another window empties the open form, hiding balances there does not', async ({
  extension,
}) => {
  const { page, home, send } = await newWallet(extension, 'QBIT_REGTEST')
  const { first, added } = await addAccount(extension, home)
  const draft = draftOn('QBIT_REGTEST')
  await home.openSend()
  await send.fillDraft(draft)
  // The account has nothing to send, and the form says so.
  await expect(send.createError).toBeVisible()

  const other = new WalletHomePage(await extension.openWallet('/main'))
  await other.waitUntilReady()
  // Neither the account nor the network changes: the open form keeps its values.
  await savePreference(other, true)
  await send.expectDraft(draft)
  await expect(send.createError).toBeVisible()
  // A change to the form here leaves the preference the other window saved.
  await send.memoInput.fill(`${draft.memo}, edited`)
  await expectSavedUiKept(page, savedPreferences(true))

  // The other window saves replace-by-fee off; this form keeps its own choice.
  await turnReplaceByFeeOff(other)
  await expect(send.replaceByFeeInput).toBeChecked()

  await other.switchAccount(first.address)
  // Emptied, the form shows the saved choice, as a new form does.
  await send.expectEmpty({ replaceByFee: false })
  // Away and back, with Advanced left open on the emptied form: the form
  // starts again at each switch, Advanced closed.
  await other.switchAccount(added.address)
  await other.switchAccount(first.address)
  await send.expectEmpty({ replaceByFee: false })
  // This page is on the account the other window selected.
  await send.back()
  await home.waitUntilReady()
  await home.expectCurrentAccount({ address: first.address })
})

test('send draft: a network switch in another window empties the open form', async ({
  extension,
}) => {
  const { home, send } = await newWallet(extension, 'QBIT_MAINNET')
  await home.openSend()
  await send.fillDraft(draftOn('QBIT_MAINNET'))

  const other = new WalletHomePage(await extension.openWallet('/main'))
  await other.waitUntilReady()
  await turnReplaceByFeeOff(other)
  await expect(send.replaceByFeeInput).toBeChecked()
  await other.switchNetwork('QBIT_REGTEST')
  await send.expectEmpty({ replaceByFee: false })
  // This page is on the network the other window selected.
  await send.back()
  await home.waitUntilReady()
  await expect(home.networkSwitcher).toContainText('Regtest')
})

test('send draft: the open page keeps the form across Back, Forward and a lock; Send starts a new one', async ({
  extension,
}) => {
  const { page, home, send } = await newWallet(extension, 'QBIT_REGTEST')
  const draft = draftOn('QBIT_REGTEST')
  await home.openSend()
  await send.fillDraft(draft)
  await send.back()
  await home.waitUntilReady()
  await page.goForward()
  await send.expectDraft(draft)

  // Locked and unlocked, on the same account and network.
  await send.back()
  await home.waitUntilReady()
  await home.openSettings()
  const settings = new SettingsPage(page)
  await settings.lockWallet()
  await settings.unlock(E2E_PASSWORD)
  await home.waitUntilReady()
  // The form's route in the same document, as a link in the page would open it.
  await page.goto(`chrome-extension://${extension.extensionId}/index.html#/wallet/tx/create`)
  await send.expectDraft(draft)

  await send.back()
  await home.waitUntilReady()
  await home.openSend()
  await send.expectEmpty()
})
