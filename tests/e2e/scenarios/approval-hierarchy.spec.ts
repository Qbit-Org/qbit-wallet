import type { Locator, Page, TestInfo } from '@playwright/test'

import { ApprovalsPage } from '../pages'
import { expect, test } from '../fixtures/test'
import { DappServer } from '../support/dapp-server'
import {
  provisionDeterministicRegtestWallet,
  waitForWalletTransactions,
} from '../support/wallet-setup'

interface BrowserQbitProvider {
  requestAccounts(): Promise<string[]>
  getAccounts(): Promise<string[]>
  signMessage(message: string): Promise<unknown>
  sendQbit(toAddress: string, satoshis: number, options?: { feeRate?: number }): Promise<string>
}

interface WindowWithQbit extends Window {
  qbit?: BrowserQbitProvider
}

type ProviderOutcome = { ok: true } | { ok: false; error: string }

// The approval popup opens at 400x600; 360x600 is the narrowest viewport the
// approval surfaces must serve with the payload visible on first paint.
const APPROVAL_VIEWPORT = { width: 360, height: 600 }
const THEMES = ['light', 'dark'] as const

// The PSBT step is a provider Send: window.qbit.sendQbit opens the production
// SignPsbt approval whose action names the transfer and lists its destination
// and amount. The request is always rejected, so nothing is signed or sent.
const SEND_SATOSHIS = 100_000
const SEND_FEE_RATE = 2
const REGTEST_UNIT = 'QBT'
const USER_REJECTED_MESSAGE = 'User rejected the request.'

/** The approval prints an address as its first and last eight characters. */
function abbreviatedAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-8)}`
}

/** The approval prints satoshis as a whole-coin amount with eight decimals. */
function formatAmount(satoshis: number): string {
  const whole = Math.floor(satoshis / 100_000_000)
  const fraction = String(satoshis % 100_000_000).padStart(8, '0')
  return `${whole}.${fraction}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches a detail row made of exactly this label followed by this value. */
function detailRowText(label: string, value: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(label)}\\s*${escapeRegExp(value)}\\s*$`)
}

async function expectAbove(upper: Locator, lower: Locator): Promise<void> {
  await expect(upper).toBeVisible()
  await expect(lower).toBeVisible()
  const [upperBox, lowerBox] = await Promise.all([upper.boundingBox(), lower.boundingBox()])
  if (!upperBox || !lowerBox) {
    throw new Error('both elements must be laid out to compare their vertical order')
  }
  expect(upperBox.y + upperBox.height).toBeLessThanOrEqual(lowerBox.y)
}

async function attachViewport(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

test('G3 approvals: unverified connect, message and PSBT payloads stay above the fold at 360x600 in light and dark', async ({
  extension,
  networkAudit,
  regtest,
}, testInfo) => {
  test.setTimeout(8 * 60_000)
  const setup = await provisionDeterministicRegtestWallet(extension)
  const fundingTxid = await regtest.fund(setup.address, '0.005')
  await waitForWalletTransactions(extension, setup.page, [fundingTxid])

  const server = new DappServer()
  const origin = await server.start()
  networkAudit.allowFixtureOrigin(origin)
  try {
    const dapp = await extension.context.newPage()
    await dapp.goto(origin, { waitUntil: 'domcontentloaded' })
    await dapp.waitForFunction(() => Boolean((window as WindowWithQbit).qbit))

    for (const theme of THEMES) {
      // Each approval popup reads the persisted theme when it opens, so the
      // mode is switched before any approval of this iteration is requested.
      await extension.requestWalletController(setup.page, 'setThemeMode', [theme])

      // Connect: the account being connected is the primary content and
      // precedes the provider-context card. The loopback fixture origin is
      // classified unverified, so the compact warning and its gate apply.
      const connectResult = dapp.evaluate(() => {
        const provider = (window as WindowWithQbit).qbit
        if (!provider) throw new Error('window.qbit is unavailable')
        return provider.requestAccounts()
      })
      const connectApproval = await ApprovalsPage.waitForNext(extension.context)
      await connectApproval.page.setViewportSize(APPROVAL_VIEWPORT)
      await connectApproval.expectTheme(theme)
      await expect(connectApproval.websiteCheckWarning('connect')).toBeInViewport({ ratio: 1 })
      await expect(connectApproval.connectAccount).toBeInViewport({ ratio: 1 })
      await expectAbove(
        connectApproval.websiteCheckWarning('connect'),
        connectApproval.connectAccount
      )
      await expectAbove(connectApproval.connectAccount, connectApproval.providerContext)
      expect(await connectApproval.contextText()).toContain(origin)
      await connectApproval.expectNoHorizontalOverflow(
        connectApproval.websiteCheckWarning('connect'),
        connectApproval.connectAccount,
        connectApproval.providerContext
      )
      await attachViewport(testInfo, connectApproval.page, `connect-approval-${theme}.png`)
      await connectApproval.expectUnverifiedGate('connect')
      await connectApproval.approveConnection()
      expect(await connectResult).toEqual([setup.address])

      // Message: the exact message begins on first paint, ahead of provider
      // metadata; the signature budget stays after the message.
      const message = `Qbit F-5 ${theme} approval — the exact message must begin above the fold`
      const messageOutcome = dapp.evaluate(async (message): Promise<ProviderOutcome> => {
        const provider = (window as WindowWithQbit).qbit
        if (!provider) throw new Error('window.qbit is unavailable')
        try {
          await provider.signMessage(message)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }, message)
      const messageApproval = await ApprovalsPage.waitForNext(extension.context)
      await messageApproval.page.setViewportSize(APPROVAL_VIEWPORT)
      await messageApproval.expectTheme(theme)
      await expect(messageApproval.messageText).toHaveText(message)
      const messageHeading = messageApproval.page.getByText('Signature request', { exact: true })
      const signatureBudget = messageApproval.page.getByTestId('p2mr-message-signature-budget')
      await expect(messageApproval.websiteCheckWarning('message')).toBeInViewport({ ratio: 1 })
      await expect(messageHeading).toBeInViewport({ ratio: 1 })
      await expect(messageApproval.messageText).toBeInViewport({ ratio: 1 })
      await expectAbove(messageApproval.websiteCheckWarning('message'), messageHeading)
      await expectAbove(messageHeading, messageApproval.messageText)
      await expectAbove(messageApproval.messageText, messageApproval.providerContext)
      await expectAbove(messageApproval.providerContext, signatureBudget)
      await messageApproval.expectNoHorizontalOverflow(
        messageApproval.websiteCheckWarning('message'),
        messageApproval.messageText,
        messageApproval.providerContext,
        signatureBudget
      )
      await attachViewport(testInfo, messageApproval.page, `message-approval-${theme}.png`)
      await messageApproval.expectUnverifiedGate('message')
      await messageApproval.reject('message')
      expect(await messageOutcome).toMatchObject({ ok: false })

      // PSBT: the provider Send opens the production SignPsbt approval. Its
      // action title and the requested destination and amount rows share the
      // first viewport with the warning and precede provider metadata and the
      // technical transaction details.
      const sendOutcome = dapp.evaluate(
        async ({ to, satoshis, feeRate }): Promise<ProviderOutcome> => {
          const provider = (window as WindowWithQbit).qbit
          if (!provider) throw new Error('window.qbit is unavailable')
          try {
            await provider.sendQbit(to, satoshis, { feeRate })
            return { ok: true }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
        { to: setup.temporaryAddress, satoshis: SEND_SATOSHIS, feeRate: SEND_FEE_RATE }
      )
      const sendApprovalOrOutcome = await Promise.race([
        ApprovalsPage.waitForNext(extension.context).then(approval => ({ approval })),
        sendOutcome.then(outcome => ({ outcome })),
      ])
      if ('outcome' in sendApprovalOrOutcome) {
        throw new Error(
          `provider sendQbit settled before approval: ${JSON.stringify(sendApprovalOrOutcome.outcome)}`
        )
      }
      const psbtApproval = sendApprovalOrOutcome.approval
      await psbtApproval.page.setViewportSize(APPROVAL_VIEWPORT)
      await psbtApproval.expectTheme(theme)
      await expect(psbtApproval.actionOverview).toBeVisible()
      await expect(psbtApproval.websiteCheckWarning('psbt')).toBeInViewport({ ratio: 1 })
      await expect(psbtApproval.actionOverview).toBeInViewport({ ratio: 1 })
      await expect(psbtApproval.actionTitle).toHaveText(`Send ${REGTEST_UNIT}`)
      await expect(psbtApproval.actionTitle).toBeInViewport({ ratio: 1 })
      // The Send action carries exactly two rows, the requested destination
      // and amount; each must name its value and lie fully in the first
      // viewport, in reading order below the title.
      const destinationRow = psbtApproval.actionDetail('To')
      const amountRow = psbtApproval.actionDetail('Amount')
      await expect(psbtApproval.actionDetails).toHaveCount(2)
      await expect(destinationRow).toHaveCount(1)
      await expect(destinationRow).toHaveText(
        detailRowText('To', abbreviatedAddress(setup.temporaryAddress))
      )
      await expect(destinationRow).toBeInViewport({ ratio: 1 })
      await expect(amountRow).toHaveCount(1)
      await expect(amountRow).toHaveText(
        detailRowText('Amount', `${formatAmount(SEND_SATOSHIS)} ${REGTEST_UNIT}`)
      )
      await expect(amountRow).toBeInViewport({ ratio: 1 })
      // What leaves the wallet follows the requested rows on first paint
      // (#271). The destination is the wallet's first account, so only the
      // exact network fee leaves the wallet and no output is unrecognised.
      const netSpend = psbtApproval.page.getByTestId('psbt-net-spend')
      await expect(netSpend).toBeInViewport({ ratio: 1 })
      const exactFee = Number(
        /Exact fee: (\d+) bits/.exec(
          await psbtApproval.page.getByTestId('psbt-network-fee-base-units').innerText()
        )?.[1]
      )
      expect(exactFee).toBeGreaterThan(0)
      await expect(psbtApproval.page.getByTestId('psbt-net-spend-amount')).toHaveText(
        `${formatAmount(exactFee)} ${REGTEST_UNIT}`
      )
      await expect(
        psbtApproval.page.locator('[data-testid^="psbt-output-unrecognised-"]')
      ).toHaveCount(0)
      await expectAbove(psbtApproval.websiteCheckWarning('psbt'), psbtApproval.actionOverview)
      await expectAbove(psbtApproval.actionTitle, destinationRow)
      await expectAbove(destinationRow, amountRow)
      await expectAbove(amountRow, netSpend)
      await expectAbove(psbtApproval.actionOverview, psbtApproval.providerContext)
      await expectAbove(
        psbtApproval.providerContext,
        psbtApproval.page.getByText('Transaction Details', { exact: true })
      )
      await psbtApproval.expectNoHorizontalOverflow(
        psbtApproval.websiteCheckWarning('psbt'),
        psbtApproval.actionOverview,
        destinationRow,
        amountRow,
        netSpend,
        psbtApproval.providerContext
      )
      await attachViewport(testInfo, psbtApproval.page, `psbt-approval-${theme}.png`)
      await psbtApproval.expectUnverifiedGate('psbt')
      await psbtApproval.reject('psbt')
      // Reject settles the provider request as a user rejection, so the send
      // is never signed or broadcast: the regtest mempool stays empty.
      expect(await sendOutcome).toEqual({ ok: false, error: USER_REJECTED_MESSAGE })
      expect(await regtest.rpc<string[]>('getrawmempool')).toEqual([])

      // Revoke the fixture origin so the next theme starts from an
      // unconnected site and opens a fresh Connect approval.
      await extension.requestWalletController<void>(setup.page, 'removeConnectedSite', [origin])
      expect(
        await dapp.evaluate(() => {
          const provider = (window as WindowWithQbit).qbit
          if (!provider) throw new Error('window.qbit is unavailable')
          return provider.getAccounts()
        })
      ).toEqual([])
    }
  } finally {
    await server.close()
  }
})
