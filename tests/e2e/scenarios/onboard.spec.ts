import { OnboardingPage, ReceivePage, WalletHomePage } from '../pages'
import { expect, test } from '../fixtures/test'
import { E2E_PASSWORD } from '../support/wallet-setup'

test('G3 onboard: preserves the recovery phrase on back navigation and opens a Qbit P2MR wallet on regtest', async ({
  extension,
  regtest,
}) => {
  const page = await extension.openWallet('/welcome')
  const onboarding = new OnboardingPage(page)
  await onboarding.chooseCreateWallet()
  await onboarding.createPassword(E2E_PASSWORD)
  const words = await onboarding.readGeneratedMnemonic()

  expect(words).toHaveLength(24)
  expect(words.every(word => /^[a-z]+$/.test(word))).toBe(true)

  await onboarding.openGeneratedMnemonicVerification()
  await onboarding.returnToGeneratedMnemonic()
  // A regenerated phrase arrives asynchronously after PBKDF2 encryption, so
  // leave enough time for the old remount behavior to replace the displayed words.
  await page.waitForTimeout(5_000)
  expect(await onboarding.readGeneratedMnemonic()).toEqual(words)

  await onboarding.acceptGeneratedMnemonic(words)
  await onboarding.submitAddressType()

  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.switchToRegtest()
  expect(await home.networkLabel()).toContain('Regtest')

  await home.openReceive()
  const address = await new ReceivePage(page).currentAddress()
  regtest.trackAccount(address)
  expect(address).toMatch(/^qbrt1[0-9a-z]+$/)

  const snapshot = await regtest.snapshot()
  expect(snapshot).toMatchObject({ chain: 'regtest', mempoolTxids: [] })
  expect(snapshot.trackedAccountIds).toContain(address)
})
