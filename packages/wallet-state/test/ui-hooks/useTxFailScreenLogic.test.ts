import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  QbitBroadcastFailure,
  QbitBroadcastIdentity,
  QbitRetainedBroadcast,
  QbitSendBroadcastClaim,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import {
  mergeQbitBroadcastRetry,
  useTxFailScreenLogic,
} from '../../src/ui-hooks/useTxFailScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const TXID = 'cd'.repeat(32)
const SIGNED_PSBT_HEX = '70736274ff' + 'ab'.repeat(40)
const claim: QbitSendBroadcastClaim = {
  chain: ChainType.QBIT_REGTEST,
  address: 'qbrt1zsender',
  origin: 'https://dapp.example',
  txid: TXID,
  outpoints: [{ txid: 'aa'.repeat(32), vout: 1 }],
}
const retained: QbitRetainedBroadcast = { psbtHex: SIGNED_PSBT_HEX, qbitSendBroadcastClaim: claim }
/** What signPsbtV2 fixes for every P2MR send, claim or not, before any broadcast. */
const identity: QbitBroadcastIdentity = { chain: ChainType.QBIT_REGTEST, txid: TXID }

const unknownFailure: QbitBroadcastFailure = {
  success: false,
  chain: ChainType.QBIT_REGTEST,
  txid: TXID,
  outcome: 'unknown',
  reason: 'network',
  lookup: 'gone',
  detail: 'network error: [url]',
}
const notSentFailure: QbitBroadcastFailure = {
  success: false,
  chain: ChainType.QBIT_REGTEST,
  txid: TXID,
  outcome: 'not_sent',
  reason: 'rejected',
  lookup: 'gone',
  detail: 'HTTP 400: dust',
}

function walletWithBroadcast() {
  return {
    ...createWalletMock(),
    signPsbtV2: vi.fn(),
    broadcastQbitTx: vi.fn(),
    checkQbitBroadcastStatus: vi.fn(),
    releaseQbitSendBroadcastClaim: vi.fn().mockResolvedValue(true),
    abandonQbitSendBroadcastClaim: vi.fn().mockResolvedValue(undefined),
    getAddressSummary: vi.fn().mockResolvedValue({ totalSatoshis: 1, spendableSatoshis: 1 }),
    getAddressBalanceV2: vi.fn().mockResolvedValue({
      availableBalance: 1,
      unavailableBalance: 0,
      totalBalance: 1,
      chainType: ChainType.QBIT_MAINNET,
    }),
  }
}

function renderFailScreen(
  routeState: { result?: QbitBroadcastFailure; retained?: QbitRetainedBroadcast } | undefined,
  wallet = walletWithBroadcast()
) {
  const harness = createHookTestHarness({ wallet: wallet as any, routeState })
  const rendered = renderHook(() => useTxFailScreenLogic(), { wrapper: harness.wrapper })
  return { ...harness, wallet, ...rendered }
}

describe('useTxFailScreenLogic', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('exposes the outcome, sanitized detail, and available actions', () => {
    const { result } = renderFailScreen({ result: unknownFailure, retained })

    expect(result.current.outcome).toBe('unknown')
    expect(result.current.reason).toBe('network')
    expect(result.current.txid).toBe(TXID)
    expect(result.current.detail).toBe('network error: [url]')
    expect(result.current.canRetry).toBe(true)
    expect(result.current.canCheckStatus).toBe(true)
    expect(result.current.busy).toBeNull()
  })

  it('offers no status check for a proven not_sent verdict', () => {
    const { result } = renderFailScreen({ result: notSentFailure, retained })
    expect(result.current.outcome).toBe('not_sent')
    expect(result.current.canRetry).toBe(true)
    expect(result.current.canCheckStatus).toBe(false)
  })

  it('degrades to a conservative unknown screen without route state', () => {
    const { result } = renderFailScreen(undefined)
    expect(result.current.outcome).toBe('unknown')
    expect(result.current.txid).toBe('')
    expect(result.current.canRetry).toBe(false)
    expect(result.current.canCheckStatus).toBe(false)
  })

  it('leaves the send flow from both exits by replacing this screen, never stepping back', () => {
    const { result, navigation } = renderFailScreen({ result: unknownFailure, retained })

    act(() => {
      result.current.onClickBack()
      result.current.onClickBackToWallet()
    })

    expect(navigation.replace).toHaveBeenCalledTimes(2)
    expect(navigation.replace).toHaveBeenNthCalledWith(1, 'MainScreen')
    expect(navigation.replace).toHaveBeenNthCalledWith(2, 'MainScreen')
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
  })

  it('releases the exact retained claim when either exit abandons a proven not_sent verdict', () => {
    const wallet = walletWithBroadcast()
    const { result, navigation } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    act(() => {
      result.current.onClickBack()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
    // Requested before the screen is replaced, so the claim never outlives
    // the retained bytes it was protecting.
    expect(wallet.releaseQbitSendBroadcastClaim.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(navigation.replace).mock.invocationCallOrder[0]!
    )

    // The other exit still leaves, but the claim was abandoned once and is
    // not released again.
    act(() => {
      result.current.onClickBackToWallet()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(navigation.replace).toHaveBeenCalledTimes(2)
    expect(wallet.broadcastQbitTx).not.toHaveBeenCalled()
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
  })

  it('releases the exact retained claim from the back-to-wallet exit as well', () => {
    const wallet = walletWithBroadcast()
    const { result, navigation } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    act(() => {
      result.current.onClickBackToWallet()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
  })

  it('releases the claim when the first broadcast was refused before dispatch by a network switch', () => {
    const wallet = walletWithBroadcast()
    // What the controller reports when another window switched networks
    // before a locally signed wallet send left the wallet: no lookup and no
    // detail, but the network and txid the retained claim names. Without
    // that txid the claim would be kept, and its inputs unspendable, after
    // the retained bytes are discarded here.
    const refusedBeforeDispatch: QbitBroadcastFailure = {
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      outcome: 'not_sent',
      reason: 'chain_changed',
    }
    const { result, navigation } = renderFailScreen(
      {
        result: refusedBeforeDispatch,
        retained: { ...retained, qbitBroadcastIdentity: identity },
      },
      wallet
    )
    expect(result.current.canRetry).toBe(true)
    expect(result.current.canCheckStatus).toBe(false)

    act(() => {
      result.current.onClickBackToWallet()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
    expect(wallet.broadcastQbitTx).not.toHaveBeenCalled()
  })

  it('releases the retained claim when the screen unmounts on a proven not_sent verdict', () => {
    const wallet = walletWithBroadcast()
    const { unmount, navigation } = renderFailScreen({ result: notSentFailure, retained }, wallet)
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()

    // Another route replaced this one without going through an exit: the
    // retained bytes are gone with the screen, so the claim goes with them.
    unmount()

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it('releases the retained claim when the page is hidden, and not again when the screen then unmounts', () => {
    const wallet = walletWithBroadcast()
    const { unmount } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    // The popup or tab closes: nothing unmounts, the page is hidden.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)

    unmount()
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
  })

  it('hands the claim back without releasing it when the screen unmounts or the page hides on an unknown verdict', () => {
    const wallet = walletWithBroadcast()
    const { unmount } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    // The background keeps the inputs reserved until it learns whether the
    // transaction reached the network; the claim no longer waits for the
    // page to close.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    unmount()

    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
  })

  it('does not release twice when an exit is followed by the unmount it causes', () => {
    const wallet = walletWithBroadcast()
    const { result, unmount, navigation } = renderFailScreen(
      { result: notSentFailure, retained },
      wallet
    )

    act(() => {
      result.current.onClickBack()
    })
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
    unmount()

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
  })

  it('defers the release to the verdict when the screen unmounts while a retry is in flight', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, unmount } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    let retry: Promise<void> | undefined
    act(() => {
      retry = result.current.onClickRetry()
    })
    await waitFor(() => expect(result.current.busy).toBe('retry'))

    // A native browser back unmounts the screen mid-retry: the retained bytes
    // are gone, but the verdict still decides what happens to the claim, so
    // nothing is released until it arrives.
    unmount()
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()

    // A proven not_sent verdict then releases the claim exactly as leaving
    // the screen on that verdict would have; the bytes cannot be retried.
    await act(async () => {
      settle(notSentFailure)
      await retry
    })
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
  })

  it('keeps the claim when the screen is left mid-retry and the verdict stays unknown', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, unmount } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    let retry: Promise<void> | undefined
    act(() => {
      retry = result.current.onClickRetry()
    })
    await waitFor(() => expect(result.current.busy).toBe('retry'))
    unmount()

    expect(wallet.abandonQbitSendBroadcastClaim).not.toHaveBeenCalled()

    // A retry that never left the wallet cannot downgrade the verdict, and
    // an unknown verdict is handed back, never released, however the screen
    // is left.
    await act(async () => {
      settle({ ...notSentFailure, reason: 'guard_blocked', lookup: undefined })
      await retry
    })
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
  })

  it('defers the release to the verdict when the page hides while a status check is in flight', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.checkQbitBroadcastStatus.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, unmount } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    let check: Promise<void> | undefined
    act(() => {
      check = result.current.onClickCheckStatus()
    })
    await waitFor(() => expect(result.current.busy).toBe('check'))

    // The popup closes mid-check: nothing unmounts, the page is hidden.
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).not.toHaveBeenCalled()

    // The check settles without proof either way: the verdict is unknown,
    // so the claim is handed back to the background, which keeps the inputs
    // reserved. The deferred settle must not release it.
    await act(async () => {
      settle({ found: false, txid: TXID, state: 'gone' })
      await check
    })
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)

    // And once the check has settled, a later unmount has nothing to do.
    unmount()
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
  })

  it('releases once, not twice, when a retry settles as not_sent after the page hid and the screen then unmounts', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, unmount } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    let retry: Promise<void> | undefined
    act(() => {
      retry = result.current.onClickRetry()
    })
    await waitFor(() => expect(result.current.busy).toBe('retry'))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })

    // The retry was dispatched and the node rejected it with absence proven
    // again: the deferred release acts on the not_sent verdict.
    await act(async () => {
      settle(notSentFailure)
      await retry
    })
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)

    unmount()
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
  })

  it('does not release on unmount after a retry or status check proved acceptance', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      via: 'broadcast',
    })
    const retried = renderFailScreen({ result: notSentFailure, retained }, wallet)
    await act(async () => {
      await retried.result.current.onClickRetry()
    })
    expect(retried.navigation.replace).toHaveBeenCalledWith('TxSuccessScreen', { txid: TXID })
    retried.unmount()
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()

    wallet.checkQbitBroadcastStatus.mockResolvedValue({
      found: true,
      txid: TXID,
      state: 'pending',
    })
    const checked = renderFailScreen({ result: unknownFailure, retained }, wallet)
    await act(async () => {
      await checked.result.current.onClickCheckStatus()
    })
    expect(checked.navigation.replace).toHaveBeenCalledWith('TxSuccessScreen', { txid: TXID })
    checked.unmount()
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
  })

  it('settles a retry that succeeds after the screen unmounted, without navigating', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, unmount, navigation, store } = renderFailScreen(
      { result: notSentFailure, retained },
      wallet
    )

    let retry: Promise<void> | undefined
    act(() => {
      retry = result.current.onClickRetry()
    })
    await waitFor(() => expect(result.current.busy).toBe('retry'))

    // The wallet locked (or a native back, or another route replacing this
    // one) unmounted the screen mid-retry: the user is on another screen by
    // the time the node accepts the retained bytes.
    unmount()
    await act(async () => {
      settle({ success: true, chain: ChainType.QBIT_REGTEST, txid: TXID, via: 'broadcast' })
      await retry
    })

    // The acceptance settled in the background: the txid is recorded and the
    // claim the controller consumed is not released again.
    expect(store.getState().transactions.qbitTx.txid).toBe(TXID)
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    // But the success screen must not replace whatever route the user is on.
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('settles a status check that finds the payment after the screen unmounted, without navigating', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.checkQbitBroadcastStatus.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, unmount, navigation, store } = renderFailScreen(
      { result: unknownFailure, retained },
      wallet
    )

    let check: Promise<void> | undefined
    act(() => {
      check = result.current.onClickCheckStatus()
    })
    await waitFor(() => expect(result.current.busy).toBe('check'))

    unmount()
    await act(async () => {
      settle({ found: true, txid: TXID, state: 'pending' })
      await check
    })

    expect(store.getState().transactions.qbitTx.txid).toBe(TXID)
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('never releases the claim when leaving an unknown verdict, and hands it back once', () => {
    const wallet = walletWithBroadcast()
    const { result, navigation } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    act(() => {
      result.current.onClickBack()
      result.current.onClickBackToWallet()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(navigation.replace).toHaveBeenCalledTimes(2)
  })

  it('still leaves the send flow, without logging, when handing the claim back fails at the port', async () => {
    const wallet = walletWithBroadcast()
    wallet.abandonQbitSendBroadcastClaim.mockRejectedValue(
      new Error('port closed http://127.0.0.1:3002')
    )
    const consoleSpies = (['error', 'warn', 'log'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    )
    const { result, navigation } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    await act(async () => {
      result.current.onClickBackToWallet()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    consoleSpies.forEach(spy => spy.mockRestore())
  })

  it.each([
    ['names another network', { ...notSentFailure, chain: ChainType.QBIT_MAINNET }],
    ['names another transaction', { ...notSentFailure, txid: 'ef'.repeat(32) }],
    [
      'carries no txid',
      {
        success: false,
        chain: ChainType.QBIT_REGTEST,
        outcome: 'not_sent',
        reason: 'chain_changed',
      } satisfies QbitBroadcastFailure,
    ],
  ])(
    'hands the claim back instead of releasing it when the not_sent verdict %s',
    (_label, verdict) => {
      const wallet = walletWithBroadcast()
      const { result, navigation } = renderFailScreen(
        { result: verdict as QbitBroadcastFailure, retained },
        wallet
      )

      act(() => {
        result.current.onClickBackToWallet()
      })

      // The verdict proves nothing about this claim's transaction; the
      // background decides it from its own record of the broadcasts.
      expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
      expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
      expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
    }
  )

  it('has nothing to release when the retained payload carries no claim', () => {
    const wallet = walletWithBroadcast()
    const { result, navigation } = renderFailScreen(
      { result: notSentFailure, retained: { psbtHex: SIGNED_PSBT_HEX } },
      wallet
    )

    act(() => {
      result.current.onClickBack()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
  })

  it('keeps the claim active for retries and releases it only when the user exits', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue(notSentFailure)
    const { result, navigation } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickRetry()
    })

    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      SIGNED_PSBT_HEX,
      claim,
      ChainType.QBIT_REGTEST,
      TXID
    )
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(result.current.outcome).toBe('not_sent')
    expect(result.current.canRetry).toBe(true)

    act(() => {
      result.current.onClickBackToWallet()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(wallet.abandonQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
  })

  it('hands the claim back on exit after a dispatched retry the node rejected, never releasing it', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue(notSentFailure)
    const { result } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickRetry()
    })
    expect(result.current.outcome).toBe('unknown')

    act(() => {
      result.current.onClickBack()
    })

    // The first attempt may still be spending the inputs.
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
  })

  it('does not release when a retry that never left the wallet leaves the verdict unknown', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      outcome: 'not_sent',
      reason: 'guard_blocked',
    })
    const { result } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickRetry()
    })
    expect(result.current.outcome).toBe('unknown')

    act(() => {
      result.current.onClickBackToWallet()
    })

    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
  })

  it('still leaves the send flow, without logging, when the release fails at the port', async () => {
    const wallet = walletWithBroadcast()
    wallet.releaseQbitSendBroadcastClaim.mockRejectedValue(
      new Error('port closed http://127.0.0.1:3002')
    )
    const consoleSpies = (['error', 'warn', 'log'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    )
    const { result, navigation } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    await act(async () => {
      result.current.onClickBackToWallet()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    consoleSpies.forEach(spy => spy.mockRestore())
  })

  it('ignores both exits while a retry is in flight so its verdict lands on this screen', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, navigation } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    let retry: Promise<void> | undefined
    act(() => {
      retry = result.current.onClickRetry()
    })
    await waitFor(() => expect(result.current.busy).toBe('retry'))

    act(() => {
      result.current.onClickBack()
      result.current.onClickBackToWallet()
    })
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.navigate).not.toHaveBeenCalled()

    await act(async () => {
      settle({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: TXID,
        outcome: 'unknown',
        reason: 'server',
        lookup: 'gone',
      })
      await retry
    })
    expect(result.current.busy).toBeNull()
    expect(result.current.reason).toBe('server')

    act(() => {
      result.current.onClickBack()
    })
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
  })

  it('ignores both exits while a status check is in flight', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.checkQbitBroadcastStatus.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result, navigation } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    let check: Promise<void> | undefined
    act(() => {
      check = result.current.onClickCheckStatus()
    })
    await waitFor(() => expect(result.current.busy).toBe('check'))

    act(() => {
      result.current.onClickBack()
      result.current.onClickBackToWallet()
    })
    expect(navigation.replace).not.toHaveBeenCalled()

    await act(async () => {
      settle({ found: false, txid: TXID, state: 'gone' })
      await check
    })
    expect(result.current.busy).toBeNull()
    expect(result.current.statusNotice).toBe('gone')
  })

  it('keeps the txid and network from the retained claim when the retry dies at the port', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockRejectedValue(new Error('port closed http://127.0.0.1:3002/tx'))
    const { result, navigation } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickRetry()
    })

    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      SIGNED_PSBT_HEX,
      claim,
      ChainType.QBIT_REGTEST,
      TXID
    )
    expect(result.current.outcome).toBe('unknown')
    expect(result.current.reason).toBe('unexpected')
    expect(result.current.detail).toBe('port closed [url]')
    expect(result.current.txid).toBe(TXID)
    expect(result.current.canCheckStatus).toBe(true)
    expect(result.current.canRetry).toBe(true)
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it('rebroadcasts the exact retained payload without signing and replaces this screen with success', async () => {
    vi.useFakeTimers()
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      via: 'broadcast',
    })
    const { result, navigation, store } = renderFailScreen(
      { result: unknownFailure, retained },
      wallet
    )

    await act(async () => {
      const retry = result.current.onClickRetry()
      await vi.advanceTimersByTimeAsync(3000)
      await retry
    })

    expect(wallet.broadcastQbitTx).toHaveBeenCalledTimes(1)
    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      SIGNED_PSBT_HEX,
      claim,
      ChainType.QBIT_REGTEST,
      TXID
    )
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    // Replace, not push: this screen and its retained payload must leave
    // browser history so a back gesture from success cannot rebroadcast.
    expect(navigation.replace).toHaveBeenCalledTimes(1)
    expect(navigation.replace).toHaveBeenCalledWith('TxSuccessScreen', { txid: TXID })
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(store.getState().transactions.qbitTx.txid).toBe(TXID)
    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBeNull()
  })

  it('replaces the verdict when a retry fails again after dispatch', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      outcome: 'unknown',
      reason: 'timeout',
      lookup: 'unavailable',
    })
    const { result, navigation } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickRetry()
    })

    expect(result.current.outcome).toBe('unknown')
    expect(result.current.reason).toBe('timeout')
    expect(result.current.detail).toBe('')
    expect(result.current.retryBlocked).toBeNull()
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it('does not downgrade an unknown verdict when the retry never left the wallet', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({
      success: false,
      chain: ChainType.QBIT_MAINNET,
      outcome: 'not_sent',
      reason: 'chain_changed',
    })
    const { result } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickRetry()
    })

    expect(result.current.outcome).toBe('unknown')
    expect(result.current.reason).toBe('network')
    expect(result.current.txid).toBe(TXID)
    expect(result.current.retryBlocked).toBe('chain_changed')
    expect(result.current.canCheckStatus).toBe(true)
  })

  it.each([
    ['as the background reports it', { ...notSentFailure, outcome: 'unknown' as const }],
    ['even when the background reports not_sent', notSentFailure],
  ])(
    'keeps an unknown verdict when the node rejects a dispatched retry, %s',
    async (_label, verdict) => {
      const wallet = walletWithBroadcast()
      wallet.broadcastQbitTx.mockResolvedValue(verdict)
      const { result } = renderFailScreen({ result: unknownFailure, retained }, wallet)

      await act(async () => {
        await result.current.onClickRetry()
      })

      // The first attempt may have reached another node behind the same
      // endpoint, so the rejection proves nothing about it: the screen
      // shows the retry's reason, without the certainty.
      expect(result.current.outcome).toBe('unknown')
      expect(result.current.reason).toBe('rejected')
      expect(result.current.detail).toBe('HTTP 400: dust')
      expect(result.current.retryBlocked).toBeNull()
      expect(result.current.canCheckStatus).toBe(true)
    }
  )

  it('accepts a proven not_sent verdict from a dispatched retry of a not_sent verdict', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({ ...notSentFailure, detail: 'HTTP 400: dust again' })
    const { result } = renderFailScreen({ result: notSentFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickRetry()
    })

    expect(result.current.outcome).toBe('not_sent')
    expect(result.current.detail).toBe('HTTP 400: dust again')
    expect(result.current.canCheckStatus).toBe(false)
  })

  it('checks the known txid on the captured network and replaces this screen with success when found', async () => {
    const wallet = walletWithBroadcast()
    wallet.checkQbitBroadcastStatus.mockResolvedValue({
      found: true,
      txid: TXID,
      state: 'pending',
    })
    const { result, navigation, store } = renderFailScreen(
      { result: unknownFailure, retained },
      wallet
    )

    await act(async () => {
      await result.current.onClickCheckStatus()
    })

    expect(wallet.checkQbitBroadcastStatus).toHaveBeenCalledWith(
      TXID,
      ChainType.QBIT_REGTEST,
      claim
    )
    expect(wallet.broadcastQbitTx).not.toHaveBeenCalled()
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    // Replace, not push: a found payment is complete, so the retained
    // payload must leave browser history rather than sit beneath success.
    expect(navigation.replace).toHaveBeenCalledTimes(1)
    expect(navigation.replace).toHaveBeenCalledWith('TxSuccessScreen', { txid: TXID })
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(store.getState().transactions.qbitTx.txid).toBe(TXID)
    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['absent', { found: false, txid: TXID, state: 'gone' }, 'gone'],
    ['unreachable', { found: false, txid: TXID, state: 'unavailable' }, 'unavailable'],
  ])(
    'keeps the unknown verdict and surfaces a notice when the status check is %s',
    async (_label, status, notice) => {
      const wallet = walletWithBroadcast()
      wallet.checkQbitBroadcastStatus.mockResolvedValue(status)
      const { result, navigation } = renderFailScreen({ result: unknownFailure, retained }, wallet)

      await act(async () => {
        await result.current.onClickCheckStatus()
      })

      expect(result.current.outcome).toBe('unknown')
      expect(result.current.statusNotice).toBe(notice)
      expect(result.current.canCheckStatus).toBe(true)
      expect(navigation.navigate).not.toHaveBeenCalled()
      expect(navigation.replace).not.toHaveBeenCalled()
      expect(wallet.getAddressSummary).not.toHaveBeenCalled()
    }
  )

  it('treats a status check that throws as unavailable, never as not sent', async () => {
    const wallet = walletWithBroadcast()
    wallet.checkQbitBroadcastStatus.mockRejectedValue(new Error('port closed'))
    const { result } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    await act(async () => {
      await result.current.onClickCheckStatus()
    })

    expect(result.current.outcome).toBe('unknown')
    expect(result.current.statusNotice).toBe('unavailable')
  })

  it('ignores overlapping retry and status-check clicks while an action is in flight', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { result } = renderFailScreen({ result: unknownFailure, retained }, wallet)

    let firstRetry: Promise<void> | undefined
    act(() => {
      firstRetry = result.current.onClickRetry()
      void result.current.onClickRetry()
      void result.current.onClickCheckStatus()
    })

    await waitFor(() => {
      expect(result.current.busy).toBe('retry')
      expect(result.current.isRetrying).toBe(true)
    })
    expect(wallet.broadcastQbitTx).toHaveBeenCalledTimes(1)
    expect(wallet.checkQbitBroadcastStatus).not.toHaveBeenCalled()

    await act(async () => {
      settle({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: TXID,
        outcome: 'unknown',
        reason: 'server',
        lookup: 'gone',
      })
      await firstRetry
    })
    expect(result.current.busy).toBeNull()
    expect(result.current.reason).toBe('server')
  })

  it('binds a retry to the network fixed at signing even when the verdict lost it', async () => {
    const wallet = walletWithBroadcast()
    // The wallet points at another network now: the controller refuses before
    // dispatch instead of broadcasting wherever the wallet currently points.
    wallet.broadcastQbitTx.mockResolvedValue({
      success: false,
      chain: ChainType.QBIT_REGTEST,
      outcome: 'not_sent',
      reason: 'chain_changed',
    })
    // A claim-less send whose first broadcast lost the controller's answer.
    const lostAnswer: QbitBroadcastFailure = {
      success: false,
      outcome: 'unknown',
      reason: 'unexpected',
    }
    const { result, navigation } = renderFailScreen(
      {
        result: lostAnswer,
        retained: { psbtHex: SIGNED_PSBT_HEX, qbitBroadcastIdentity: identity },
      },
      wallet
    )

    await act(async () => {
      await result.current.onClickRetry()
    })

    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      SIGNED_PSBT_HEX,
      undefined,
      ChainType.QBIT_REGTEST,
      TXID
    )
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    expect(result.current.outcome).toBe('unknown')
    expect(result.current.retryBlocked).toBe('chain_changed')
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('copies the known txid', () => {
    const { result, tools } = renderFailScreen({ result: unknownFailure, retained })
    act(() => {
      result.current.onClickCopyTxid()
    })
    expect(tools.copyToClipboard).toHaveBeenCalledWith(TXID)
  })
})

describe('mergeQbitBroadcastRetry', () => {
  it('keeps the txid and chain from the first attempt when the retry lacks them', () => {
    const merged = mergeQbitBroadcastRetry(notSentFailure, {
      success: false,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
    })
    expect(merged.result).toMatchObject({
      txid: TXID,
      chain: ChainType.QBIT_REGTEST,
      reason: 'invalid_transaction',
    })
    expect(merged.retryBlocked).toBeNull()
  })

  it('reports a blocked retry without touching an unknown verdict', () => {
    const merged = mergeQbitBroadcastRetry(unknownFailure, {
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      outcome: 'not_sent',
      reason: 'guard_blocked',
    })
    expect(merged.result).toBe(unknownFailure)
    expect(merged.retryBlocked).toBe('guard_blocked')
  })

  it('never downgrades an unknown verdict to not_sent after a dispatched retry', () => {
    const merged = mergeQbitBroadcastRetry(unknownFailure, notSentFailure)
    expect(merged.result).toEqual({ ...notSentFailure, outcome: 'unknown' })
    expect(merged.retryBlocked).toBeNull()
  })
})
