import { type Page } from '@playwright/test'

import { ApprovalsPage, ReceivePage } from '../e2e/pages'
import { expect, test } from '../e2e/fixtures/test'
import { DappServer } from '../e2e/support/dapp-server'
import type { ExtensionSession } from '../e2e/support/extension-session'
import {
  provisionDeterministicRegtestWallet,
  waitForAddressUsed,
  waitForWalletTransactions,
} from '../e2e/support/wallet-setup'

/**
 * 1.0.8 flows that need the regtest node: website PSBT batches (#157) and
 * New Address selecting the account that owns the address (#141). Run with
 * the e2e build, like the gate.
 */

type Outcome<T> = { ok: true; value: T } | { ok: false; code?: number | undefined; message: string }

interface QbitWindow extends Window {
  qbit?: {
    requestAccounts(): Promise<string[]>
    signPsbts(
      psbts: string[],
      options: { chain: 'QBIT_REGTEST'; autoFinalized: boolean }[]
    ): Promise<string[]>
    pushPsbt(psbt: string): Promise<string>
  }
}

const BUDGET = /Signatures: (\d+) new for all transactions; (\d+) before, (\d+) after/

async function connectedDapp(extension: ExtensionSession, origin: string): Promise<Page> {
  const dapp = await extension.context.newPage()
  await dapp.goto(origin, { waitUntil: 'domcontentloaded' })
  await dapp.waitForFunction(() => Boolean((window as QbitWindow).qbit))
  const connected = dapp.evaluate(() => (window as QbitWindow).qbit!.requestAccounts())
  await (await ApprovalsPage.waitForNext(extension.context)).approveConnection()
  await connected
  return dapp
}

/** Start a signPsbts request from the page; settle it as a value or an error. */
function requestBatch(dapp: Page, psbts: string[]): Promise<Outcome<string[]>> {
  return dapp.evaluate(async psbts => {
    try {
      const value = await (window as QbitWindow).qbit!.signPsbts(
        psbts,
        psbts.map(() => ({ chain: 'QBIT_REGTEST' as const, autoFinalized: true }))
      )
      return { ok: true as const, value }
    } catch (error) {
      const { code, message } = error as { code?: number; message?: string }
      return { ok: false as const, code, message: String(message ?? error) }
    }
  }, psbts)
}

async function unsignedPsbts(extension: ExtensionSession, page: Page, to: string, count: number) {
  const psbts: string[] = []
  for (let index = 0; index < count; index += 1) {
    const { psbtHex } = await extension.requestWalletController<{ psbtHex: string }>(
      page,
      'createSendQbitPsbt',
      [
        {
          to,
          amount: 10_000 + index * 1_000,
          feeRate: 2,
          enableRBF: true,
          memo: `batch entry ${index}`,
        },
      ]
    )
    psbts.push(psbtHex)
  }
  return psbts
}

/** In a batch approval, open entry `index` (counting entries not yet signed) and sign it. */
async function signEntry(approval: ApprovalsPage, unsignedPosition: number) {
  const page = approval.page
  await page.getByText('View', { exact: true }).nth(unsignedPosition).click()
  await expect(page.getByTestId('psbt-network-fee-base-units')).toBeVisible({ timeout: 60_000 })
  const unverified = page.getByTestId('psbt-unverified-website-confirmation-input')
  if (await unverified.isVisible()) await unverified.check()
  const closed = page.waitForEvent('close', { timeout: 120_000 }).then(() => 'closed' as const)
  closed.catch(() => undefined)
  try {
    await page.getByTestId('sign-psbt-button').click()
  } catch (error) {
    if (!page.isClosed()) throw error
  }
  const backToList = page
    .getByTestId('multisign-signature-budget')
    .waitFor({ timeout: 120_000 })
    .then(() => 'list' as const)
  const risk = page
    .getByTestId('risk-confirmation-input')
    .waitFor({ timeout: 120_000 })
    .then(() => 'risk' as const)
  backToList.catch(() => undefined)
  risk.catch(() => undefined)
  const next = await Promise.race([closed, backToList, risk])
  if (next === 'risk') {
    await page.getByTestId('risk-confirmation-input').fill('CONFIRM')
    await page
      .getByTestId('risk-confirm-button')
      .click()
      .catch(error => {
        if (!page.isClosed()) throw error
      })
    await Promise.race([closed, backToList])
  }
}

test('signPsbts: a batch of different PSBTs signs every entry in any order; a second request and a lock are handled', async ({
  extension,
  networkAudit,
  regtest,
}) => {
  test.setTimeout(10 * 60_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  const funding = await regtest.fund(setup.address, '0.01')
  await waitForWalletTransactions(extension, setup.page, [funding])

  const server = new DappServer()
  const origin = await server.start()
  networkAudit.allowFixtureOrigin(origin)
  try {
    const dapp = await connectedDapp(extension, origin)

    // Three different PSBTs, each needing a new signature from the same key.
    const psbts = await unsignedPsbts(extension, setup.page, setup.temporaryAddress, 3)
    const batch = requestBatch(dapp, psbts)
    const approval = await ApprovalsPage.waitForNext(extension.context)
    await expect(approval.page.getByTestId('qbit-provider-batch-review-required')).toBeVisible({
      timeout: 60_000,
    })
    const budgetText = await approval.page.getByTestId('multisign-signature-budget').innerText()
    const [, required, before, after] = budgetText.match(BUDGET) ?? []
    expect(budgetText, 'the batch states its signatures').toMatch(BUDGET)
    expect(Number(required)).toBe(3)
    expect(Number(before) - Number(after)).toBe(3)
    console.log(`batch budget: ${budgetText}`)

    // Sign them out of order: the third, then the first, then the second.
    await signEntry(approval, 2)
    await signEntry(approval, 0)
    await signEntry(approval, 0)
    const signed = await batch
    expect(signed.ok, JSON.stringify(signed)).toBe(true)
    if (!signed.ok) return
    expect(signed.value).toHaveLength(3)
    signed.value.forEach((hex, index) => expect(hex).not.toBe(psbts[index]))
    // A signed entry is valid on chain.
    const txid = await dapp.evaluate(
      psbt => (window as QbitWindow).qbit!.pushPsbt(psbt),
      signed.value[1]!
    )
    regtest.trackTransaction(txid)
    await regtest.waitForMempoolTransaction(txid)
    await regtest.mine(1)
    // The next PSBTs spend that transaction's confirmed change.
    await waitForWalletTransactions(extension, setup.page, [txid])
    const more = await unsignedPsbts(extension, setup.page, setup.temporaryAddress, 2)

    // A second signPsbts while a batch approval is open is refused, and the open one stays.
    const open = requestBatch(dapp, more)
    const first = await Promise.race([
      ApprovalsPage.waitForNext(extension.context).then(page => ({ page })),
      open.then(result => ({ result })),
    ])
    if ('result' in first)
      throw new Error(
        `the second batch settled before its approval: ${JSON.stringify(first.result)}`
      )
    const openApproval = first.page
    await expect(openApproval.page.getByTestId('multisign-signature-budget')).toBeVisible({
      timeout: 60_000,
    })
    await dapp.bringToFront()
    const second = await requestBatch(dapp, more)
    expect(second).toMatchObject({ ok: false })
    expect(second.ok ? '' : second.message).toMatch(/Another approval request is already pending/i)
    expect(openApproval.page.isClosed()).toBe(false)
    const focusedIsApproval = await openApproval.page.evaluate(async () => {
      const [current, focused] = await Promise.all([
        chrome.windows.getCurrent(),
        chrome.windows.getLastFocused(),
      ])
      return current.id === focused.id
    })
    console.log(
      `after the refused second request, the approval window is focused: ${focusedIsApproval}`
    )

    // A lock before the batch is signed ends the request.
    await extension.requestWalletController(setup.page, 'lockWallet')
    const ended = await open
    expect(ended).toMatchObject({ ok: false })
    console.log(`batch ended by the lock: ${JSON.stringify(ended)}`)
    await expect.poll(() => openApproval.page.isClosed(), { timeout: 30_000 }).toBe(true)
    expect(await regtest.snapshot().then(snapshot => snapshot.mempoolTxids.length)).toBe(0)
  } finally {
    await server.close()
  }
})

test('New Address selects the account that owns the new address', async ({
  extension,
  regtest,
}) => {
  test.setTimeout(5 * 60_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  await setup.home.openReceive()
  const receive = new ReceivePage(setup.page)
  expect(await receive.currentAddress()).toBe(setup.address)

  const funding = await regtest.fund(setup.address, '0.002')
  await waitForAddressUsed(extension, setup.page, setup.address)
  expect(funding).toMatch(/^[0-9a-f]{64}$/)
  await setup.page.reload({ waitUntil: 'domcontentloaded' })
  await receive.waitUntilReady()
  await receive.expectCurrentAddressUsed()

  const rotation = await receive.rotateAddress()
  expect(rotation.previous).toBe(setup.address)
  const current = await extension.requestWalletController<{ address: string }>(
    setup.page,
    'getCurrentAccount'
  )
  expect(current.address).toBe(rotation.current)
})
