import { OnboardingPage, ReceivePage, SendPage, SettingsPage, WalletHomePage } from '../pages'
import { expect, test } from '../fixtures/test'
import type { ExtensionSession } from '../support/extension-session'
import {
  E2E_PASSWORD,
  E2E_WRONG_PASSWORD,
  onboardNewRegtestWallet,
  provisionDeterministicRegtestWallet,
  waitForAddressUsed,
  waitForWalletTransactions,
} from '../support/wallet-setup'

interface AddressBalanceProbe {
  amount: string
  confirm_amount: string
  pending_amount: string
}

interface WalletKeyringProbe {
  index: number
}

const LOCKED_METHOD = 'walletLocked'
const AUTO_LOCKED_METHOD = 'walletAutoLocked'
const ONBOARDING_GRACE_PERIOD_MS = 10 * 60 * 1000

test('G3 lock: rejects a wrong password and survives unlock plus browser restart', async ({
  extension,
  regtest,
}) => {
  const setup = await provisionDeterministicRegtestWallet(extension)
  const extensionId = extension.extensionId
  const fundingTxid = await regtest.fund(setup.address, '0.001')
  await waitForWalletTransactions(extension, setup.page, [fundingTxid])
  // Receive marks the address used from the receive ledger, which lags the
  // UTXO index; wait for it before checking how Receive shows the address.
  await waitForAddressUsed(extension, setup.page, setup.address)
  const expectedBalance = await extension.requestWalletController<AddressBalanceProbe>(
    setup.page,
    'getAddressBalance',
    [setup.address]
  )

  await setup.home.openReceive()
  const fundedReceive = new ReceivePage(setup.page)
  // The used address stays on screen until New Address selects a fresh one,
  // and that selection has to survive the lock and the browser restart below.
  expect(await fundedReceive.currentAddress()).toBe(setup.address)
  await fundedReceive.expectCurrentAddressUsed()
  const { current: safeReceiveAddress } = await fundedReceive.rotateAddress()
  expect(safeReceiveAddress).not.toBe(setup.address)
  expect(await fundedReceive.previousAddresses()).toContain(setup.address)
  await setup.page.goto(`chrome-extension://${extensionId}/index.html#/main`, {
    waitUntil: 'domcontentloaded',
  })
  await setup.home.waitUntilReady()

  await setup.home.openSettings()
  let settings = new SettingsPage(setup.page)
  await settings.lockWallet()
  await settings.submitWrongPassword(E2E_WRONG_PASSWORD)
  await settings.unlock(E2E_PASSWORD)

  await setup.home.waitUntilReady()
  await setup.home.openReceive()
  expect(await new ReceivePage(setup.page).currentAddress()).toBe(safeReceiveAddress)
  await setup.page.goto(`chrome-extension://${extensionId}/index.html#/settings`, {
    waitUntil: 'domcontentloaded',
  })
  settings = new SettingsPage(setup.page)
  await settings.lockWallet()

  await extension.restart()
  expect(extension.extensionId).toBe(extensionId)
  const restartedPage = await extension.openWallet('/main')
  settings = new SettingsPage(restartedPage)
  await settings.waitForUnlock()
  await settings.submitWrongPassword(E2E_WRONG_PASSWORD)
  await settings.unlock(E2E_PASSWORD)

  const restartedHome = new WalletHomePage(restartedPage)
  await restartedHome.waitUntilReady()
  expect(await restartedHome.networkLabel()).toContain('Regtest')
  await restartedHome.openReceive()
  expect(await new ReceivePage(restartedPage).currentAddress()).toBe(safeReceiveAddress)
  expect(
    await extension.requestWalletController<AddressBalanceProbe>(
      restartedPage,
      'getAddressBalance',
      [setup.address]
    )
  ).toEqual(expectedBalance)
})

test('P2 auto-lock: bounds onboarding keepalive across an MV3 restart', async ({ extension }) => {
  test.setTimeout(240_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  const extensionId = extension.extensionId
  const currentKeyring = await extension.requestWalletController<WalletKeyringProbe>(
    setup.page,
    'getCurrentKeyring'
  )
  expect(currentKeyring.index).toBeGreaterThanOrEqual(0)

  await setup.home.openAddWallet()
  await setup.page.getByTestId('restore-from-mnemonics-option').click()
  await expect(setup.page).toHaveURL(/#\/account\/create-hd-wallet$/)
  await expect(setup.page.getByTestId('mnemonic-import-word-0')).toBeVisible()

  // Provisioning leaves the browser's initial about:blank page and the
  // onboarding page open. Close everything but this test's page, so the only
  // keepalive left is the one on this page.
  for (const page of extension.context.pages()) {
    if (page !== setup.page) {
      await page.close()
    }
  }

  await extension.captureWalletBroadcasts(setup.page)
  // Advance only the UI's monotonic elapsed-time reading, so the keepalive
  // reaches its ten-minute bound now: this avoids a ten-minute test without
  // weakening or adding a test switch to production behavior. The auto-lock
  // stays at its default 30 minutes, far past this test's budget, so the
  // lock awaited below can only be the keepalive's own.
  await setup.page.evaluate(gracePeriodMs => {
    const monotonicNow = performance.now.bind(performance)
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => monotonicNow() + gracePeriodMs,
    })
  }, ONBOARDING_GRACE_PERIOD_MS)

  // Past its grace period the keepalive stops refreshing and locks on its
  // next tick, ten seconds at most; the budget leaves room for a slow one.
  await expect
    .poll(() => extension.walletBroadcastMethods(setup.page), {
      timeout: 120_000,
      intervals: [250, 500, 1_000],
    })
    .toContain(LOCKED_METHOD)
  expect(await extension.walletBroadcastMethods(setup.page)).not.toContain(AUTO_LOCKED_METHOD)
  await setup.page.evaluate(() => {
    delete (performance as unknown as { now?: () => number }).now
  })

  expect(await extension.requestWalletController<boolean>(setup.page, 'isUnlocked')).toBe(false)
  await expect(
    extension.requestWalletController(setup.page, 'getMnemonics', [E2E_PASSWORD, currentKeyring])
  ).rejects.toThrow()

  await extension.restart()
  expect(extension.extensionId).toBe(extensionId)
  const restartedPage = await extension.openWallet('/main')
  // The restarted service worker accepts port connections before its stores
  // finish rehydrating, so an immediate probe can throw ("Cannot read
  // properties of undefined (reading 'getState')"). Retry until the
  // background answers; later requests then see an initialized controller.
  await expect(async () => {
    expect(await extension.requestWalletController<boolean>(restartedPage, 'isUnlocked')).toBe(false)
  }).toPass({ timeout: 30_000 })
  await expect(
    extension.requestWalletController(restartedPage, 'getMnemonics', [E2E_PASSWORD, currentKeyring])
  ).rejects.toThrow()
})

test('G3 lock: locks when the last normal browser window closes', async ({ extension }) => {
  const setup = await onboardNewRegtestWallet(extension)
  expect(await extension.requestWalletController<boolean>(setup.page, 'isUnlocked')).toBe(true)
  expect(
    await extension.requestWalletController<boolean>(setup.page, 'getLockOnWindowsClosed')
  ).toBe(true)

  // A wallet page in a popup window, as approvals open: it is not a normal
  // window, so it does not keep the wallet unlocked, and it watches for the
  // lock while every normal window closes.
  const popupOpened = extension.context.waitForEvent('page')
  await setup.page.evaluate(async () => {
    await chrome.windows.create({ type: 'popup', url: chrome.runtime.getURL('index.html#/main') })
  })
  const popup = await popupOpened
  await popup.waitForLoadState('domcontentloaded')
  await extension.captureWalletBroadcasts(popup)

  for (const page of extension.context.pages()) {
    if (page !== popup) {
      await page.close()
    }
  }

  await expect
    .poll(() => extension.walletBroadcastMethods(popup), { timeout: 30_000 })
    .toContain(LOCKED_METHOD)
  expect(await extension.requestWalletController<boolean>(popup, 'isUnlocked')).toBe(false)
  await new SettingsPage(popup).waitForUnlock()

  // A normal window opened again shows the lock screen. (Chrome on macOS
  // keeps running with no window at all; Chrome on Linux quits with its last
  // window, which is why the popup stays open here.)
  const reopened = await extension.openWallet('/main')
  const settings = new SettingsPage(reopened)
  await settings.waitForUnlock()
  await settings.unlock(E2E_PASSWORD)
  await new WalletHomePage(reopened).waitUntilReady()
})

// The send form's auto-lock time: 15 minutes (`getAutoLockTimes`,
// @qbit/wallet-shared), a delay the background arms no other timer for.
const SEND_FORM_AUTO_LOCK_ID = 8
const SEND_FORM_AUTO_LOCK_MS = 15 * 60 * 1000
// How long the background's timer of that length lasts in that test.
const SEND_FORM_AUTO_LOCK_WAIT_MS = 30 * 1000

/**
 * Make the service worker's timers of `fromMs` last `toMs` instead, from the
 * test's side: the wallet has no test switch for its auto-lock time. Resolves
 * to `shortened`, which reads how many timers were shortened so far, and
 * `restore`, which puts the worker's own setTimeout back and resolves to that
 * number.
 */
async function shortenServiceWorkerTimers(
  extension: ExtensionSession,
  fromMs: number,
  toMs: number
): Promise<{ shortened: () => Promise<number>; restore: () => Promise<number> }> {
  const worker = await extension.serviceWorker()
  await worker.evaluate(
    ({ fromMs, toMs }) => {
      type SetTimeout = (handler: unknown, ms?: number, ...args: unknown[]) => unknown
      const scope = globalThis as unknown as {
        setTimeout: SetTimeout
        qbitE2eShortenedTimers?: { setTimeout: SetTimeout; shortened: number }
      }
      const ownSetTimeout = scope.setTimeout
      const state = { setTimeout: ownSetTimeout, shortened: 0 }
      scope.qbitE2eShortenedTimers = state
      scope.setTimeout = (handler, ms, ...args) => {
        if (ms !== fromMs) return ownSetTimeout(handler, ms, ...args)
        state.shortened++
        return ownSetTimeout(handler, toMs, ...args)
      }
    },
    { fromMs, toMs }
  )
  return {
    shortened: () =>
      worker.evaluate(() => {
        const scope = globalThis as unknown as { qbitE2eShortenedTimers?: { shortened: number } }
        return scope.qbitE2eShortenedTimers?.shortened ?? 0
      }),
    restore: () =>
      worker.evaluate(() => {
        const scope = globalThis as unknown as {
          setTimeout: unknown
          qbitE2eShortenedTimers?: { setTimeout: unknown; shortened: number }
        }
        const state = scope.qbitE2eShortenedTimers!
        scope.setTimeout = state.setTimeout
        delete scope.qbitE2eShortenedTimers
        return state.shortened
      }),
  }
}

test('G3 lock: sends pages opened before the wallet existed to the unlock screen', async ({
  extension,
}) => {
  test.setTimeout(240_000)
  // Pages that loaded before the wallet existed, as the page that creates it
  // does, must go to the unlock screen when it locks, like any other wallet
  // page (#198). Each must still be that document when the wallet locks: a
  // reload, such as provisioning's or a language change's, starts the page
  // afresh and would hide the failure. The marks, read before each lock, show
  // it.
  const untouchedPage = await extension.openWallet('/welcome')
  const creatingPage = await extension.openWallet('/welcome')
  const untouchedMark = await extension.markDocument(untouchedPage)
  const creatingMark = await extension.markDocument(creatingPage)

  await new OnboardingPage(creatingPage).createNewWallet(E2E_PASSWORD)
  const home = new WalletHomePage(creatingPage)
  await home.waitUntilReady()
  await home.switchToRegtest()

  // Control: a page opened once the wallet exists, on the screen of the
  // first lock below. It shows the lock reaches the wallet pages.
  const laterPage = await extension.openWallet('/main')
  const laterHome = new WalletHomePage(laterPage)
  await laterHome.waitUntilReady()
  await laterHome.openReceive()
  await new ReceivePage(laterPage).waitUntilReady()

  // Lock from the background, over a port of the test's own: the lock
  // button goes to the unlock screen by itself.
  const lockFromBackground = async () => {
    expect(await extension.documentMark(creatingPage)).toBe(creatingMark)
    await extension.requestWalletController<void>(creatingPage, 'lockWallet')
    expect(await extension.requestWalletController<boolean>(creatingPage, 'isUnlocked')).toBe(false)
  }
  const creatingUnlock = new SettingsPage(creatingPage)
  const unlockToHome = async () => {
    await creatingUnlock.unlock(E2E_PASSWORD)
    await home.waitUntilReady()
  }

  await home.openReceive()
  await new ReceivePage(creatingPage).waitUntilReady()
  expect(await extension.documentMark(untouchedPage)).toBe(untouchedMark)
  await lockFromBackground()
  await new SettingsPage(laterPage).waitForUnlock()
  await creatingUnlock.waitForUnlock()
  await new SettingsPage(untouchedPage).waitForUnlock()
  await unlockToHome()

  await home.openSettings()
  await creatingUnlock.waitUntilReady()
  await lockFromBackground()
  await creatingUnlock.waitForUnlock()
  await unlockToHome()

  // The send form locks through the background's auto-lock timer, as
  // reported: the timer runs out, the background locks and broadcasts the
  // auto-lock, and the page goes to the unlock screen. Only the wait is
  // shorter: the worker's timers of the 15-minute auto-lock time last 30
  // seconds, set up before the time is armed. A focus or visibility change
  // on another wallet page is a screen action that starts the time over, so
  // this page is left alone in the browser first. After the tap on Send
  // nothing here is a screen action: controller calls and the broadcast
  // capture are not.
  for (const page of extension.context.pages()) {
    if (page !== creatingPage) await page.close()
  }
  await extension.captureWalletBroadcasts(creatingPage)
  const timers = await shortenServiceWorkerTimers(
    extension,
    SEND_FORM_AUTO_LOCK_MS,
    SEND_FORM_AUTO_LOCK_WAIT_MS
  )
  await extension.requestWalletController<void>(creatingPage, 'setAutoLockTimeId', [
    SEND_FORM_AUTO_LOCK_ID,
  ])
  await home.openSend()
  // The setting and the tap each armed the auto-lock's timer: the patch
  // applies before the wait below, which would otherwise last 15 minutes.
  expect(await timers.shortened()).toBeGreaterThanOrEqual(1)
  const send = new SendPage(creatingPage)
  await send.waitForCreate()
  expect(await extension.documentMark(creatingPage)).toBe(creatingMark)
  // The capture is kept on this document's window, so finding the lock in it
  // also shows the page was not reloaded while it waited.
  await expect
    .poll(() => extension.walletBroadcastMethods(creatingPage), {
      timeout: 90_000,
      intervals: [1_000],
    })
    .toContain(LOCKED_METHOD)
  expect(await extension.walletBroadcastMethods(creatingPage)).toContain(AUTO_LOCKED_METHOD)
  expect(await timers.restore()).toBeGreaterThanOrEqual(1)
  await creatingUnlock.waitForUnlock()
  // The lock took this page from the send form it showed unlocked. With the
  // account and network unchanged, the unlock brings the form back, and its
  // Back goes Home.
  await creatingUnlock.unlock(E2E_PASSWORD, '/wallet/tx/create')
  await send.waitForCreate()
  await send.back()
  await home.waitUntilReady()
})
