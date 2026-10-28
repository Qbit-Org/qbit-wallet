import { expect, type Page } from '@playwright/test'

import {
  OnboardingPage,
  ReceivePage,
  RecoveryReportPage,
  WalletHomePage,
  type RecoveryReportSummary,
} from '../pages'
import type { ExtensionSession } from './extension-session'

export const E2E_PASSWORD = 'Qbit-E2E-Only!42'
export const E2E_WRONG_PASSWORD = 'Qbit-E2E-Wrong!42'
export const FIXED_MNEMONIC = [
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'abandon',
  'about',
] as const

export interface NewWalletSetup {
  page: Page
  words: string[]
  address: string
  home: WalletHomePage
}

export interface DeterministicWalletSetup extends NewWalletSetup {
  temporaryAddress: string
}

export interface PendingRestoredWalletSetup {
  page: Page
  home: WalletHomePage
  temporaryAddress: string
  report: RecoveryReportPage
  reportSummary: RecoveryReportSummary
  restoreDurationMs: number
}

interface ReceiveStateProbe {
  current: { address: string; used: boolean } | null
  previous: { address: string; used: boolean }[]
}

interface UtxoProbe {
  txid: string
}

async function readCurrentAddress(page: Page, home: WalletHomePage): Promise<string> {
  await home.openReceive()
  const address = await new ReceivePage(page).currentAddress()
  await page.goBack()
  await home.waitUntilReady()
  return address
}

export async function waitForAddressUsed(
  extension: ExtensionSession,
  page: Page,
  address: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await extension.requestWalletController<ReceiveStateProbe>(
          page,
          'getQbitReceiveState'
        )
        return [state.current, ...state.previous].some(
          candidate => candidate?.address === address && candidate.used
        )
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe(true)
}

export async function waitForWalletTransactions(
  extension: ExtensionSession,
  page: Page,
  transactionIds: readonly string[]
): Promise<void> {
  await expect
    .poll(
      async () => {
        const utxos = await extension.requestWalletController<UtxoProbe[]>(page, 'getQbitUtxos')
        return transactionIds.every(transactionId =>
          utxos.some(utxo => utxo.txid === transactionId)
        )
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe(true)
}

export async function onboardNewRegtestWallet(
  extension: ExtensionSession,
  password = E2E_PASSWORD,
  passphrase = ''
): Promise<NewWalletSetup> {
  const page = await extension.openWallet('/welcome')
  const onboarding = new OnboardingPage(page)
  const words = await onboarding.createNewWallet(password, passphrase)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.switchToRegtest()
  const address = await readCurrentAddress(page, home)
  return { page, words, address, home }
}

export async function provisionDeterministicRegtestWallet(
  extension: ExtensionSession,
  options: {
    words?: readonly string[]
    passphrase?: string
    password?: string
  } = {}
): Promise<DeterministicWalletSetup> {
  const initial = await onboardNewRegtestWallet(extension, options.password ?? E2E_PASSWORD)
  const temporaryAddress = initial.address

  await extension.requestWalletController<void>(initial.page, 'createKeyringWithMnemonics', [
    (options.words ?? FIXED_MNEMONIC).join(' '),
    "m/87'/1'/0'/0",
    options.passphrase ?? '',
    9,
    1,
  ])
  await initial.page.reload({ waitUntil: 'domcontentloaded' })
  await initial.home.waitUntilReady()
  const address = await readCurrentAddress(initial.page, initial.home)

  return {
    ...initial,
    address,
    temporaryAddress,
  }
}

export async function beginRegtestWalletRestoreThroughUi(
  extension: ExtensionSession,
  options: {
    words?: readonly string[]
    passphrase?: string
    password?: string
  } = {}
): Promise<PendingRestoredWalletSetup> {
  const initial = await onboardNewRegtestWallet(extension, options.password ?? E2E_PASSWORD)
  const temporaryAddress = initial.address

  await initial.home.openWalletManagement()
  await initial.page.getByTestId('add-wallet-button').click()
  const onboarding = new OnboardingPage(initial.page)
  const restoreStartedAt = performance.now()
  await onboarding.restoreAdditionalWallet(
    options.words ?? FIXED_MNEMONIC,
    options.passphrase ?? ''
  )

  const report = new RecoveryReportPage(initial.page)
  const reportSummary = await report.summary()
  const restoreDurationMs = performance.now() - restoreStartedAt
  if (reportSummary.network !== 'Regtest') {
    throw new Error(`deterministic restore ran on ${reportSummary.network}, expected Regtest`)
  }
  await report.expectFloorsCompleted()

  return {
    page: initial.page,
    home: initial.home,
    temporaryAddress,
    report,
    reportSummary,
    restoreDurationMs,
  }
}
