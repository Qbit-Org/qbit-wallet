import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  QbitBroadcastFailure,
  QbitBroadcastIdentity,
  QbitSendBroadcastClaim,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { useTxConfirmScreenLogic } from '../../src/ui-hooks/useTxConfirmScreenLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const TXID = 'cd'.repeat(32)
const SIGNED_PSBT_HEX = '70736274ff' + 'ab'.repeat(40)
/** Valid signed bytes for some other transaction: a wrong paste into the readonly signer. */
const OTHER_SIGNED_PSBT_HEX = '70736274ff' + 'ba'.repeat(40)
const toSignData = { psbtHex: '70736274ff00', toSignInputs: [] }
const claim: QbitSendBroadcastClaim = {
  chain: ChainType.QBIT_REGTEST,
  address: 'qbrt1zsender',
  origin: 'https://dapp.example',
  txid: TXID,
  outpoints: [{ txid: 'aa'.repeat(32), vout: 1 }],
}
/** What signPsbtV2 fixes for every P2MR send, claim or not, before any broadcast. */
const identity: QbitBroadcastIdentity = { chain: ChainType.QBIT_REGTEST, txid: TXID }

function walletWithBroadcast() {
  return {
    ...createWalletMock(),
    signPsbtV2: vi.fn(),
    broadcastQbitTx: vi.fn(),
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

describe('useTxConfirmScreenLogic', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('broadcasts the signed payload with its claim and replaces the signer with the success screen', async () => {
    vi.useFakeTimers()
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      via: 'broadcast',
    })
    const { wrapper, navigation, tools } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    await act(async () => {
      const confirm = result.current.onClickConfirm([
        { psbtHex: SIGNED_PSBT_HEX, qbitSendBroadcastClaim: claim },
      ])
      await vi.advanceTimersByTimeAsync(3000)
      await confirm
    })

    expect(wallet.broadcastQbitTx).toHaveBeenCalledTimes(1)
    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      SIGNED_PSBT_HEX,
      claim,
      ChainType.QBIT_REGTEST,
      TXID
    )
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    // Replace, not push: the signer must leave browser history so a back
    // gesture from the success screen cannot re-enter it and sign again.
    expect(navigation.replace).toHaveBeenCalledTimes(1)
    expect(navigation.replace).toHaveBeenCalledWith('TxSuccessScreen', { txid: TXID })
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(tools.showLoading).toHaveBeenLastCalledWith(false)
  })

  it('tells the success screen a consolidation batch went out, so it can offer the next (#277)', async () => {
    vi.useFakeTimers()
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockResolvedValue({
      success: true,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      via: 'broadcast',
    })
    const batch = {
      ...toSignData,
      qbitConsolidation: {
        confirmedOutputCount: 700,
        outputLimit: 500,
        amount: 1_000_000,
        fundingOutputCounts: [2],
      },
    }
    const { wrapper, navigation } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData: batch },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    await act(async () => {
      const confirm = result.current.onClickConfirm([
        { psbtHex: SIGNED_PSBT_HEX, qbitBroadcastIdentity: identity },
      ])
      await vi.advanceTimersByTimeAsync(3000)
      await confirm
    })

    expect(navigation.replace).toHaveBeenCalledWith('TxSuccessScreen', {
      txid: TXID,
      consolidation: true,
    })
  })

  it('hands the structured failure and the retained payload to the failure screen', async () => {
    const wallet = walletWithBroadcast()
    const failure: QbitBroadcastFailure = {
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      outcome: 'unknown',
      reason: 'network',
      lookup: 'gone',
      detail: 'network error: [url]',
    }
    wallet.broadcastQbitTx.mockResolvedValue(failure)
    const { wrapper, navigation } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    await act(async () => {
      await result.current.onClickConfirm([{ psbtHex: SIGNED_PSBT_HEX }])
    })

    // Replace, not push: the signer must leave browser history so a back
    // gesture from the recovery screen cannot re-enter it.
    expect(navigation.replace).toHaveBeenCalledTimes(1)
    expect(navigation.replace).toHaveBeenCalledWith('TxFailScreen', {
      result: failure,
      retained: { psbtHex: SIGNED_PSBT_HEX },
    })
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    expect(wallet.getAddressSummary).not.toHaveBeenCalled()
  })

  it('reports an unknown verdict instead of throwing when the controller call itself fails', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockRejectedValue(new Error('port closed http://127.0.0.1:3002/tx'))
    const { wrapper, navigation } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    await act(async () => {
      await result.current.onClickConfirm([{ psbtHex: SIGNED_PSBT_HEX }])
    })

    expect(navigation.replace).toHaveBeenCalledWith('TxFailScreen', {
      result: {
        success: false,
        outcome: 'unknown',
        reason: 'unexpected',
        detail: 'port closed [url]',
      },
      retained: { psbtHex: SIGNED_PSBT_HEX },
    })
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('binds a claim-less send to the network and txid fixed at signing when the controller call fails after dispatch', async () => {
    const wallet = walletWithBroadcast()
    // The port died after the background dispatched the request: the answer
    // never arrives, so only what was captured before dispatch can name the
    // transaction and the network it went to.
    wallet.broadcastQbitTx.mockRejectedValue(new Error('Extension context invalidated'))
    const { wrapper, navigation } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    await act(async () => {
      await result.current.onClickConfirm([
        { psbtHex: SIGNED_PSBT_HEX, qbitBroadcastIdentity: identity },
      ])
    })

    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      SIGNED_PSBT_HEX,
      undefined,
      ChainType.QBIT_REGTEST,
      TXID
    )
    expect(navigation.replace).toHaveBeenCalledWith('TxFailScreen', {
      result: {
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: TXID,
        outcome: 'unknown',
        reason: 'unexpected',
        detail: 'Extension context invalidated',
      },
      retained: { psbtHex: SIGNED_PSBT_HEX, qbitBroadcastIdentity: identity },
    })
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
  })

  it('names the expected txid so externally signed bytes for another transaction are refused before dispatch', async () => {
    const wallet = walletWithBroadcast()
    // The controller compares the bytes against the txid fixed at creation
    // and proves non-submission instead of broadcasting a transaction the
    // user never approved under an identity that does not belong to it.
    const refused: QbitBroadcastFailure = {
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      outcome: 'not_sent',
      reason: 'invalid_transaction',
      detail: 'signed transaction does not match the approved transaction',
    }
    wallet.broadcastQbitTx.mockResolvedValue(refused)
    const { wrapper, navigation } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    await act(async () => {
      await result.current.onClickConfirm([
        { psbtHex: OTHER_SIGNED_PSBT_HEX, qbitBroadcastIdentity: identity },
      ])
    })

    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      OTHER_SIGNED_PSBT_HEX,
      undefined,
      ChainType.QBIT_REGTEST,
      TXID
    )
    expect(navigation.replace).toHaveBeenCalledWith('TxFailScreen', {
      result: refused,
      retained: { psbtHex: OTHER_SIGNED_PSBT_HEX, qbitBroadcastIdentity: identity },
    })
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
  })

  it('recovers the txid and network from the retained claim when the controller call itself fails', async () => {
    const wallet = walletWithBroadcast()
    wallet.broadcastQbitTx.mockRejectedValue(new Error('Extension context invalidated'))
    const { wrapper, navigation } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    await act(async () => {
      await result.current.onClickConfirm([
        { psbtHex: SIGNED_PSBT_HEX, qbitSendBroadcastClaim: claim },
      ])
    })

    expect(navigation.replace).toHaveBeenCalledWith('TxFailScreen', {
      result: {
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: TXID,
        outcome: 'unknown',
        reason: 'unexpected',
        detail: 'Extension context invalidated',
      },
      retained: { psbtHex: SIGNED_PSBT_HEX, qbitSendBroadcastClaim: claim },
    })
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
  })

  /**
   * Start a confirm whose broadcast stays pending, then unmount the screen
   * underneath it: the wallet locked (the layout guard redirects to the
   * unlock screen), a native browser back, or another route replacing this
   * one, all while the node has not answered yet.
   */
  function confirmThenLeave(wallet: ReturnType<typeof walletWithBroadcast>) {
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const harness = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result, unmount } = renderHook(() => useTxConfirmScreenLogic(), {
      wrapper: harness.wrapper,
    })
    let confirm: Promise<void> | undefined
    act(() => {
      confirm = result.current.onClickConfirm([
        { psbtHex: SIGNED_PSBT_HEX, qbitSendBroadcastClaim: claim },
      ])
    })
    expect(wallet.broadcastQbitTx).toHaveBeenCalledTimes(1)
    unmount()
    return { ...harness, settle: (value: unknown) => settle(value), confirm: () => confirm }
  }

  it('settles a broadcast that succeeds after the screen unmounted, without navigating', async () => {
    vi.useFakeTimers()
    const wallet = walletWithBroadcast()
    const { settle, confirm, navigation, store } = confirmThenLeave(wallet)

    await act(async () => {
      settle({ success: true, chain: ChainType.QBIT_REGTEST, txid: TXID, via: 'broadcast' })
      await vi.advanceTimersByTimeAsync(3000)
      await confirm()
    })

    // The acceptance settled in the background: the txid is recorded and the
    // claim the controller consumed is not released.
    expect(store.getState().transactions.qbitTx.txid).toBe(TXID)
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).not.toHaveBeenCalled()
    // But the success screen must not replace whatever route the user is on.
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('releases the retained claim, without navigating, when a proven not_sent verdict arrives after the screen unmounted', async () => {
    const wallet = walletWithBroadcast()
    const { settle, confirm, navigation } = confirmThenLeave(wallet)

    await act(async () => {
      settle({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: TXID,
        outcome: 'not_sent',
        reason: 'rejected',
        lookup: 'gone',
      })
      await confirm()
    })

    // The retained bytes went with this screen, so nothing can retry them:
    // the claim is released exactly as leaving the recovery screen on this
    // verdict would release it, and the recovery screen is not shown.
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(wallet.abandonQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('hands the claim back, without navigating, when an unknown verdict arrives after the screen unmounted', async () => {
    const wallet = walletWithBroadcast()
    const { settle, confirm, navigation } = confirmThenLeave(wallet)

    await act(async () => {
      settle({
        success: false,
        chain: ChainType.QBIT_REGTEST,
        txid: TXID,
        outcome: 'unknown',
        reason: 'network',
        lookup: 'unavailable',
      })
      await confirm()
    })

    // The node may hold the transaction: its inputs stay reserved, by the
    // background rather than by a claim nothing can retry any more.
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.abandonQbitSendBroadcastClaim).toHaveBeenCalledWith(claim)
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('still navigates when the verdict arrives while the screen is mounted', async () => {
    const wallet = walletWithBroadcast()
    let settle: (value: unknown) => void = () => undefined
    wallet.broadcastQbitTx.mockReturnValue(new Promise(resolve => (settle = resolve)))
    const { wrapper, navigation } = createHookTestHarness({
      wallet: wallet as any,
      routeState: { toSignData },
    })
    const { result } = renderHook(() => useTxConfirmScreenLogic(), { wrapper })

    let confirm: Promise<void> | undefined
    act(() => {
      confirm = result.current.onClickConfirm([{ psbtHex: SIGNED_PSBT_HEX }])
    })
    const failure: QbitBroadcastFailure = {
      success: false,
      chain: ChainType.QBIT_REGTEST,
      txid: TXID,
      outcome: 'unknown',
      reason: 'network',
      lookup: 'gone',
    }
    await act(async () => {
      settle(failure)
      await confirm
    })

    expect(navigation.replace).toHaveBeenCalledWith('TxFailScreen', {
      result: failure,
      retained: { psbtHex: SIGNED_PSBT_HEX },
    })
  })
})
