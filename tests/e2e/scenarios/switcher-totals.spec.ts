import { ChainType } from '../../../packages/wallet-types/src'
import { CHAINS_MAP } from '../../../packages/wallet-shared/src/constants/common'
import { expect, test } from '../fixtures/test'
import { SendPage, SettingsPage, switcherAmount, WalletHomePage } from '../pages'
import { dropBrowserHttpCache } from '../support/browser-cache'
import type { QbitAccountTotal } from '../../../packages/wallet-shared/src/types/common'
import type { ExtensionSession } from '../support/extension-session'
import type { RegtestController } from '../support/regtest'
import { E2E_PASSWORD, provisionDeterministicRegtestWallet } from '../support/wallet-setup'

interface KeyringProbe {
  key: string
  accounts: { address: string }[]
}

/** The unit the switcher shows after each total on Regtest, in every locale. */
const REGTEST_UNIT = CHAINS_MAP[ChainType.QBIT_REGTEST]!.unit

/** A total as the switcher shows it on Regtest. */
const shown = (sats: number | bigint) => switcherAmount(sats, REGTEST_UNIT)

/** A balance card amount with its eight decimals ("0.25000000") in sats. */
function cardSats(amount: string): bigint {
  const [whole = '', fraction = ''] = amount.split('.')
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))
}

/**
 * Two wallets: the one created at onboarding, and the public test phrase's,
 * which gets a second account, "Spending", that is current. `funding` names
 * what each account receives, in coins, before the wallet locks and unlocks
 * in a new page: the explorer lets each reply be reused for 10 s, and the
 * background keeps each total it measured (the home screen's, before the
 * funding) for a minute; a lock forgets those. So the next reads are of the
 * funded chain.
 */
async function setUpFundedWallets(
  extension: ExtensionSession,
  regtest: RegtestController,
  funding: { created?: string; restored: string; spending: string }
) {
  const setup = await provisionDeterministicRegtestWallet(extension)
  const keyrings = await extension.requestWalletController<KeyringProbe[]>(
    setup.page,
    'getKeyrings'
  )
  const created = keyrings.find(keyring =>
    keyring.accounts.some(account => account.address === setup.temporaryAddress)
  )
  const restored = keyrings.find(keyring =>
    keyring.accounts.some(account => account.address === setup.address)
  )
  if (!created || !restored || keyrings.length !== 2) {
    throw new Error('expected the onboarding wallet and the restored wallet')
  }
  await extension.requestWalletController(setup.page, 'deriveNewAccountFromMnemonic', [
    restored,
    'Spending',
  ])
  const restoredAccounts = (
    await extension.requestWalletController<KeyringProbe[]>(setup.page, 'getKeyrings')
  ).find(keyring => keyring.key === restored.key)!.accounts
  const spending = restoredAccounts[1]!.address
  await setup.home.expectCurrentAccount({ accountName: 'Spending', address: spending })

  await regtest.fund(setup.address, funding.restored)
  await regtest.fund(spending, funding.spending)
  if (funding.created) await regtest.fund(setup.temporaryAddress, funding.created)
  await dropBrowserHttpCache(setup.page)
  await extension.requestWalletController(setup.page, 'lockWallet')
  const page = await extension.openWallet('/main')
  await setup.page.close()
  await new SettingsPage(page).unlock(E2E_PASSWORD)
  const home = new WalletHomePage(page)
  await home.waitUntilReady()
  await home.expectCurrentAccount({ accountName: 'Spending', address: spending })
  return {
    page,
    home,
    created,
    restored,
    first: setup.address,
    spending,
    other: setup.temporaryAddress,
  }
}

test('switch account balances: funded accounts show their totals, wallets their sums, the current row the home total', async ({
  extension,
  regtest,
}) => {
  const { home, created, restored, first, spending, other } = await setUpFundedWallets(
    extension,
    regtest,
    { restored: '0.5', spending: '0.25', created: '1.125' }
  )
  await expect.poll(() => home.balanceAmount()).toBe('0.25000000')
  const homeTotal = cardSats(await home.balanceAmount())

  const sheet = await home.openAccountSwitcher()
  await expect
    .poll(() => sheet.totalTexts())
    .toEqual({
      [`account-balance-${first}`]: `0.5 ${REGTEST_UNIT}`,
      [`account-balance-${spending}`]: `0.25 ${REGTEST_UNIT}`,
      [`account-balance-${other}`]: `1.125 ${REGTEST_UNIT}`,
      [`wallet-total-${restored.key}`]: `0.75 ${REGTEST_UNIT}`,
      [`wallet-total-${created.key}`]: `1.125 ${REGTEST_UNIT}`,
    })
  await expect(sheet.pendingTotals).toHaveCount(0)
  // The current account's row shows the home screen's total.
  await expect(sheet.accountBalance(spending)).toHaveText(switcherAmount(homeTotal, REGTEST_UNIT))
  await sheet.close()
})

test('switch account balances: a send between two accounts of the wallet makes their kept totals out of date, and the reopened switcher shows both new totals', async ({
  extension,
  pqcMetrics,
  regtest,
}) => {
  test.setTimeout(6 * 60_000)
  const { page, home, restored, first, spending } = await setUpFundedWallets(extension, regtest, {
    restored: '0.5',
    spending: '0.25',
  })
  await expect.poll(() => home.balanceAmount()).toBe('0.25000000')

  // Every statistics read the switcher has the background send, in order:
  // a fresh read carries `qbit_fresh`, which no other read of the wallet does.
  const statisticsReads: string[] = []
  extension.context.on('request', request => {
    const url = new URL(request.url())
    const address = url.pathname.match(/\/address\/([^/]+)$/)?.[1]
    if (address && url.searchParams.has('qbit_fresh')) {
      statisticsReads.push(decodeURIComponent(address))
    }
  })
  const keptTotal = async (address: string) =>
    (
      await extension.requestWalletController<QbitAccountTotal[]>(page, 'getQbitAccountTotals', [
        [address],
      ])
    )[0]!

  // The totals before the send, which the background keeps.
  let sheet = await home.openAccountSwitcher()
  await expect
    .poll(() => sheet.totalTexts())
    .toMatchObject({
      [`account-balance-${first}`]: shown(50_000_000),
      [`account-balance-${spending}`]: shown(25_000_000),
      [`wallet-total-${restored.key}`]: shown(75_000_000),
    })
  await sheet.close()
  expect(statisticsReads).toContain(first)

  // 0.1 from Spending to the wallet's first account.
  await home.openSend()
  const send = new SendPage(page)
  await send.enterTransfer(first, '0.1')
  await send.chooseFeeRateOption(0)
  await send.continueToReview()
  const displayedFee = await send.exactFeeBaseUnits()
  const inputCount = await send.reviewedInputCount()
  const beforeSend = await keptTotal(first)
  const sent = await send.signAndBroadcast()
  const afterSend = await keptTotal(first)
  const checkedAt = Date.now()
  const readsBeforeBroadcast = statisticsReads.length
  pqcMetrics.record({
    accountId: spending,
    durationMs: sent.durationMs,
    inputCount,
    operation: 'wallet-send-sign',
    transactionId: sent.transactionId,
  })
  // The receiving account's total from before is still kept, no longer
  // fresh. While its minute has not run out, only the broadcast can have
  // made it so; on a host slow enough to let the minute end first, the
  // check proves nothing either way and is left out, which the run says.
  expect(afterSend.totalBalance).toBe(50_000_000)
  const withinItsMinute =
    beforeSend.fresh && beforeSend.readAt !== null && checkedAt < beforeSend.readAt + 60_000
  if (withinItsMinute) {
    expect(afterSend.fresh, 'the broadcast, not the minute, ended its freshness').toBe(false)
    test.info().annotations.push({
      type: 'shown',
      description: `the broadcast ended the freshness ${checkedAt - beforeSend.readAt!} ms after the total was read`,
    })
  } else {
    test.info().annotations.push({
      type: 'not shown',
      description:
        'the total read before the send was past its minute when checked after the broadcast',
    })
  }
  await regtest.waitForMempoolTransaction(sent.transactionId)
  const fee = await regtest.mempoolFeeBaseUnits(sent.transactionId)
  expect(fee).toBe(displayedFee)
  await send.finishSuccess()
  await home.waitUntilReady()

  // No lock and no wait for the minute: each opening reads again until the
  // explorer shows the transaction.
  const expected = {
    [`account-balance-${first}`]: shown(60_000_000),
    [`account-balance-${spending}`]: shown(15_000_000 - fee),
    [`wallet-total-${restored.key}`]: shown(75_000_000 - fee),
  }
  await expect
    .poll(
      async () => {
        sheet = await home.openAccountSwitcher()
        await expect(sheet.pendingTotals).toHaveCount(0, { timeout: 20_000 })
        const texts = await sheet.totalTexts()
        await sheet.close()
        return Object.fromEntries(Object.keys(expected).map(key => [key, texts[key]]))
      },
      { timeout: 50_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toEqual(expected)
  // The receiving account was read again after the broadcast.
  expect(statisticsReads.slice(readsBeforeBroadcast)).toContain(first)
})
