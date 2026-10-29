import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  DecodedPsbt,
  KeyringType,
  type LocalPsbtSummary,
  PsbtActionDetailType,
  PsbtActionType,
  RiskType,
  ToSignData,
  createBlockedWebsiteResult,
  createClearWebsiteResult,
  type QbitSendBroadcastClaim,
  type SignedData,
  type WebsiteSafetyResult,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import logger from 'loglevel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PSBT_DECODE_TIMEOUT_MS,
  PSBT_WEBSITE_CHECK_TIMEOUT_MS,
  useSignPsbtLogic,
} from '../../src/ui-hooks/useSignPsbtLogic'
import { accountActions } from '../../src/reducers/accounts'
import { createHookTestHarness, createWalletMock } from './testHelpers'

const SAFE_WEBSITE_RESULT = createClearWebsiteResult('example.test')

const DECODED_PSBT: DecodedPsbt = {
  inputInfos: [
    {
      txid: '11'.repeat(32),
      vout: 0,
      address: 'qb1zexample',
      value: 10_000,
      sighashType: 1,
      alkanes: [],
    },
  ],
  outputInfos: [],
  feeRate: 1,
  fee: 100,
  features: { rbf: false },
  risks: [],
  isScammer: false,
  recommendedFeeRate: 1,
  shouldWarnFeeRate: false,
  isCompleted: true,
}

/** A batch analysis with nothing flagged, for the harness's current account. */
function localSummaryFor(toSignDatas: ToSignData[], account = 'qb1ztestaccount'): LocalPsbtSummary {
  return {
    totalFee: 0,
    totalInput: 0,
    completedCount: 0,
    hasSighashNone: false,
    parseErrorCount: 0,
    items: toSignDatas.map(() => ({
      inputCount: 1,
      outputCount: 1,
      feeRate: '1.00',
      fee: 100,
      totalInput: 10_000,
      isCompleted: true,
      hasSighashNone: false,
      parseError: false,
      risks: [],
    })),
    account,
    chain: ChainType.QBIT_REGTEST,
  }
}

function createSignPsbtWallet() {
  return {
    ...createWalletMock(),
    checkWebsite: vi.fn().mockResolvedValue(SAFE_WEBSITE_RESULT),
    getConnectedSites: vi.fn().mockResolvedValue([]),
    decodePsbt: vi.fn().mockResolvedValue(DECODED_PSBT),
    analyzeLocalPsbts: vi.fn(async (toSignDatas: ToSignData[]) => localSummaryFor(toSignDatas)),
    updateConnectSite: vi.fn().mockResolvedValue(undefined),
    signPsbtV2: vi.fn(),
    signLocalBatchPsbt: vi.fn(),
    reserveExternallySignedQbitSend: vi.fn(),
    releaseQbitSendBroadcastClaim: vi.fn().mockResolvedValue(true),
    getCurrentAccount: vi.fn().mockResolvedValue({ address: 'qb1ztestaccount' }),
  }
}

/** What the wallet fixes for a P2MR send when it builds the PSBT, before any signer sees it. */
const SEND_IDENTITY = { chain: ChainType.QBIT_REGTEST, txid: 'cd'.repeat(32) }
/** The reservation the wallet registers for that send, whichever signer produced the bytes. */
const SEND_CLAIM: QbitSendBroadcastClaim = {
  chain: ChainType.QBIT_REGTEST,
  address: 'qbrt1zsender',
  origin: 'qbit-wallet',
  txid: SEND_IDENTITY.txid,
  outpoints: [{ txid: '11'.repeat(32), vout: 0 }],
}

/**
 * The in-wallet send flow: no dapp session, and the confirm screen receives
 * the signed result through `handleConfirm` instead of an approval.
 */
function createSendProps(toSignData: ToSignData, handleConfirm: (data: unknown[]) => void) {
  return { params: { data: { toSignDatas: [toSignData] } }, handleConfirm }
}

// The id ApprovalScreen read for the approval it renders.
const APPROVAL_ID = 'rendered-approval-id'

function createProps(toSignDatas: ToSignData[]) {
  return {
    approvalId: APPROVAL_ID,
    params: {
      data: { toSignDatas },
      session: {
        origin: 'https://example.test',
        icon: '',
        name: 'Example',
      },
    },
  }
}

describe('useSignPsbtLogic approval recovery', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('exposes a decode error instead of continuing to report loading', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockRejectedValueOnce(new Error('internal decode details'))
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'bad-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.decodeError).toBe(true)
    })

    expect(result.current.showLoading).toBe(false)
    expect(result.current.currentDecodedPsbt).toBeUndefined()
  })

  it('signs the same PSBT whose exact OP_RETURN bytes back the confirmation view', async () => {
    const toSignData: ToSignData = {
      psbtHex: 'psbt-with-6a02abcd',
      toSignInputs: [],
      qbitP2mrSigningKeys: [
        {
          inputIndex: 0,
          publicKey: '11'.repeat(32),
          leafHash: '22'.repeat(32),
        },
      ],
    }
    const decodedWithOpReturn: DecodedPsbt = {
      ...DECODED_PSBT,
      outputInfos: [
        {
          type: 'op_return',
          address: '',
          value: 0,
          alkanes: [],
          opReturn: {
            scriptPubKeyHex: '6a02abcd',
            chunks: [
              {
                pushHeaderHex: '02',
                dataHex: 'abcd',
                dataByteLength: 2,
                dataStartByte: 2,
                dataEndByte: 4,
              },
            ],
          },
        },
      ],
    }
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockResolvedValueOnce(decodedWithOpReturn)
    wallet.signPsbtV2.mockResolvedValueOnce({ psbtHex: 'signed-psbt-with-6a02abcd' })
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignPsbtLogic(createProps([toSignData])), { wrapper })

    await waitFor(() => {
      expect(result.current.currentDecodedPsbt?.outputInfos[0]?.opReturn?.scriptPubKeyHex).toBe(
        '6a02abcd'
      )
    })

    await act(async () => {
      result.current.onClickSign()
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(wallet.signPsbtV2).toHaveBeenCalledWith(toSignData)
    })
    expect(wallet.decodePsbt).toHaveBeenCalledWith(toSignData.psbtHex, 'https://example.test', {
      statedRecipients: [],
      suppliedByWebsite: false,
    })
  })

  it('surfaces a synchronously thrown decode error', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockImplementationOnce(() => {
      throw new Error('synchronous internal decode details')
    })
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'bad-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.decodeError).toBe(true)
    })

    expect(result.current.showLoading).toBe(false)
  })

  it('rejects the provider approval from the decode-error recovery action', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockRejectedValueOnce(new Error('decode failed'))
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'bad-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.decodeError).toBe(true)
    })

    act(() => {
      result.current.onRejectApprovalError()
    })

    expect(approval.rejectApproval).toHaveBeenCalledTimes(1)
    expect(approval.rejectApproval).toHaveBeenCalledWith(APPROVAL_ID)
  })

  it('clears the decode error and starts one clean decode retry', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt
      .mockRejectedValueOnce(new Error('decode failed'))
      .mockResolvedValueOnce(DECODED_PSBT)
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'retry-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.decodeError).toBe(true)
    })

    act(() => {
      result.current.onRetryDecode()
    })

    await waitFor(() => {
      expect(result.current.currentDecodedPsbt).toEqual(DECODED_PSBT)
    })
    expect(result.current.decodeError).toBe(false)
    expect(wallet.decodePsbt).toHaveBeenCalledTimes(2)
  })

  it('does not carry a decode error to another transaction in a multi-PSBT approval', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockImplementation((psbtHex: string) =>
      psbtHex === 'bad-psbt'
        ? Promise.reject(new Error('decode failed'))
        : Promise.resolve(DECODED_PSBT)
    )
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            { psbtHex: 'bad-psbt', toSignInputs: [] },
            { psbtHex: 'good-psbt', toSignInputs: [] },
          ])
        ),
      { wrapper }
    )

    act(() => {
      result.current.multiSignList[0].onClick()
    })
    await waitFor(() => {
      expect(result.current.decodeError).toBe(true)
    })

    act(() => {
      result.current.multiSignList[1].onClick()
    })
    await waitFor(() => {
      expect(result.current.currentDecodedPsbt).toEqual(DECODED_PSBT)
    })

    expect(result.current.decodeError).toBe(false)
    expect(result.current.currentToSignData?.psbtHex).toBe('good-psbt')
  })

  it('surfaces a rejected website safety check without an unhandled loading state', async () => {
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockRejectedValueOnce(new Error('network details'))
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'valid-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.websiteCheckStatus).toBe('unverified')
    })

    expect(result.current.showLoading).toBe(false)
    expect(result.current.isBlocked).toBe(false)
  })

  it('keeps loading transaction data after the website safety check fails', async () => {
    let resolveDecode: (decodedPsbt: DecodedPsbt) => void = () => undefined
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockRejectedValueOnce(new Error('network details'))
    wallet.decodePsbt.mockReturnValueOnce(
      new Promise<DecodedPsbt>(resolve => {
        resolveDecode = resolve
      })
    )
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'valid-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.websiteCheckStatus).toBe('unverified')
    })
    expect(result.current.showLoading).toBe(true)

    act(() => {
      resolveDecode(DECODED_PSBT)
    })

    await waitFor(() => {
      expect(result.current.showLoading).toBe(false)
    })
    expect(result.current.currentDecodedPsbt).toEqual(DECODED_PSBT)
  })

  it('times out a stalled decode and ignores its late result after retry', async () => {
    vi.useFakeTimers()
    let settleFirstDecode: ((decodedPsbt: DecodedPsbt) => void) | undefined
    const firstDecode = new Promise<DecodedPsbt>(resolve => {
      settleFirstDecode = resolve
    })
    const retryDecodedPsbt = { ...DECODED_PSBT, fee: 200 }
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockRejectedValueOnce(new Error('network details'))
    wallet.decodePsbt.mockReturnValueOnce(firstDecode).mockResolvedValueOnce(retryDecodedPsbt)
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'valid-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_DECODE_TIMEOUT_MS)
      await Promise.resolve()
    })

    expect(result.current.websiteCheckStatus).toBe('unverified')
    expect(result.current.decodeError).toBe(true)
    expect(result.current.showLoading).toBe(false)
    expect(result.current.currentDecodedPsbt).toBeUndefined()

    await act(async () => {
      result.current.onRetryDecode()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(wallet.decodePsbt).toHaveBeenCalledTimes(2)
    expect(result.current.decodeError).toBe(false)
    expect(result.current.currentDecodedPsbt).toEqual(retryDecodedPsbt)

    await act(async () => {
      settleFirstDecode?.(DECODED_PSBT)
      await Promise.resolve()
    })

    expect(result.current.currentDecodedPsbt).toEqual(retryDecodedPsbt)
  })

  it('times out a never-settling PSBT website check instead of loading indefinitely', async () => {
    vi.useFakeTimers()
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(new Promise(() => undefined))
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'valid-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })

    expect(result.current.websiteCheckStatus).toBe('unverified')
    expect(result.current.showLoading).toBe(false)
  })

  it('surfaces a scammer result that arrives after the website check times out', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'valid-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'late scammer warning')
      )
      await Promise.resolve()
    })

    expect(result.current.websiteCheckStatus).toBe('blocked')
    expect(result.current.isBlocked).toBe(true)
  })

  it('keeps a timeout unverified when a clear PSBT website verdict arrives late', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'valid-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    await act(async () => {
      settleCheck?.(createClearWebsiteResult('example.test'))
      await Promise.resolve()
    })

    expect(result.current.websiteCheckStatus).toBe('unverified')
    expect(result.current.websiteCheckWarning).toContain('timed out')
  })

  it('rejects a multi-PSBT approval on the first click for a late website scammer verdict', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            { psbtHex: 'first-psbt', toSignInputs: [] },
            { psbtHex: 'second-psbt', toSignInputs: [] },
          ])
        ),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    await act(async () => {
      result.current.multiSignList[0].onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.currentDecodedPsbt).toEqual(DECODED_PSBT)

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'late scammer warning')
      )
      await Promise.resolve()
    })
    expect(result.current.isBlocked).toBe(true)

    act(() => {
      result.current.onClickBack()
    })

    expect(approval.rejectApproval).toHaveBeenCalledTimes(1)
    expect(approval.rejectApproval).toHaveBeenCalledWith(APPROVAL_ID)
    expect(result.current.showMultiSignView).toBe(false)
  })

  it('returns to the multi-sign list for a current-PSBT-only scammer verdict', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockResolvedValueOnce({ ...DECODED_PSBT, isScammer: true })
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            { psbtHex: 'scammer-psbt', toSignInputs: [] },
            { psbtHex: 'second-psbt', toSignInputs: [] },
          ])
        ),
      { wrapper }
    )

    act(() => {
      result.current.multiSignList[0].onClick()
    })
    await waitFor(() => {
      expect(result.current.isBlocked).toBe(true)
    })

    act(() => {
      result.current.onClickBack()
    })

    expect(approval.rejectApproval).not.toHaveBeenCalled()
    expect(result.current.showMultiSignView).toBe(true)
  })

  it('ignores a timed-out website result after a clean retry succeeds', async () => {
    vi.useFakeTimers()
    let settleFirstCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const firstCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleFirstCheck = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(firstCheck).mockResolvedValueOnce(SAFE_WEBSITE_RESULT)
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'valid-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    await act(async () => {
      result.current.onRetryWebsiteCheck()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(wallet.checkWebsite).toHaveBeenCalledTimes(2)
    expect(result.current.websiteCheckStatus).toBe('clear')

    await act(async () => {
      settleFirstCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'stale scammer warning')
      )
      await Promise.resolve()
    })

    expect(result.current.websiteCheckStatus).toBe('clear')
    expect(result.current.isBlocked).toBe(false)
  })

  it('does not restore quick-sign trust after the website check is retried', async () => {
    let settleTrustUpdate: (() => void) | undefined
    const pendingTrustUpdate = new Promise<void>(resolve => {
      settleTrustUpdate = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite
      .mockResolvedValueOnce(SAFE_WEBSITE_RESULT)
      .mockReturnValueOnce(new Promise(() => undefined))
    wallet.updateConnectSite.mockReturnValueOnce(pendingTrustUpdate)
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            { psbtHex: 'first-psbt', toSignInputs: [] },
            { psbtHex: 'second-psbt', toSignInputs: [] },
          ])
        ),
      { wrapper }
    )

    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))

    let trustSite: Promise<void>
    act(() => {
      trustSite = result.current.onTrustSite()
    })
    expect(wallet.updateConnectSite).toHaveBeenCalledWith('https://example.test', {
      allowQuickMultiSign: true,
    })

    await act(async () => {
      result.current.onRetryWebsiteCheck()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('checking')

    await act(async () => {
      settleTrustUpdate?.()
      await trustSite
    })

    expect(result.current.allowQuickMultiSign).toBe(false)
  })

  it('stops quick signing when a late scammer verdict arrives during signing', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    let settleSign: ((signedData: { psbtHex: string }) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const pendingSign = new Promise<{ psbtHex: string }>(resolve => {
      settleSign = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    wallet.signLocalBatchPsbt.mockReturnValueOnce(pendingSign)
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            { psbtHex: 'first-psbt', toSignInputs: [] },
            { psbtHex: 'second-psbt', toSignInputs: [] },
          ])
        ),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    let quickSign: Promise<void>
    act(() => {
      quickSign = result.current.onQuickMultiSign()
    })
    await act(async () => {
      vi.advanceTimersByTime(50)
      await vi.waitFor(() => expect(wallet.signLocalBatchPsbt).toHaveBeenCalled())
    })
    expect(wallet.signLocalBatchPsbt).toHaveBeenCalledTimes(1)

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'late scammer warning')
      )
      await Promise.resolve()
    })
    expect(result.current.isBlocked).toBe(true)

    await act(async () => {
      settleSign?.({ psbtHex: 'signed-first-psbt' })
      await quickSign
    })

    expect(wallet.signLocalBatchPsbt).toHaveBeenCalledTimes(1)
    expect(result.current.signedCount).toBe(0)
    expect(approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('does not resolve a single local sign after a late scammer verdict', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    let settleSign: ((signedData: { psbtHex: string }) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const pendingSign = new Promise<{ psbtHex: string }>(resolve => {
      settleSign = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    wallet.signPsbtV2.mockReturnValueOnce(pendingSign)
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    act(() => {
      result.current.onClickSign()
    })
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'late scammer warning')
      )
      await Promise.resolve()
    })
    expect(result.current.isBlocked).toBe(true)

    await act(async () => {
      settleSign?.({ psbtHex: 'signed-single-psbt' })
      await Promise.resolve()
    })

    expect(result.current.signedCount).toBe(0)
    expect(approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('does not report a guard-rejected successful local sign as retryable', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    let settleSign: ((signedData: { psbtHex: string }) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const pendingSign = new Promise<{ psbtHex: string }>(resolve => {
      settleSign = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    wallet.signPsbtV2.mockReturnValueOnce(pendingSign)
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    let signOutcome: Promise<boolean>
    act(() => {
      signOutcome = result.current.onClickSign()
    })
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'late scammer warning')
      )
      await Promise.resolve()
    })
    expect(result.current.isBlocked).toBe(true)

    let outcome: boolean | undefined
    await act(async () => {
      settleSign?.({ psbtHex: 'signed-single-psbt' })
      outcome = await signOutcome
    })

    // The signed data is discarded, but the successful sign consumed the
    // restored-floor challenge, so a false outcome here would re-arm the Sign
    // button for a retry that can only fail.
    expect(outcome).toBe(true)
    expect(result.current.signedCount).toBe(0)
    expect(approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('reports a failed local sign so restored-floor retry affordances can re-arm', async () => {
    const wallet = createSignPsbtWallet()
    wallet.signPsbtV2.mockRejectedValueOnce(new Error('signer unavailable'))
    wallet.signPsbtV2.mockResolvedValueOnce({ psbtHex: 'signed-single-psbt' })
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => expect(result.current.showLoading).toBe(false))

    let firstOutcome: boolean | undefined
    await act(async () => {
      firstOutcome = await result.current.onClickSign()
    })
    expect(firstOutcome).toBe(false)
    expect(approval.resolveApproval).not.toHaveBeenCalled()

    let retryOutcome: boolean | undefined
    await act(async () => {
      retryOutcome = await result.current.onClickSign()
    })
    expect(retryOutcome).toBe(true)
    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, [
      { psbtHex: 'signed-single-psbt' },
    ])
  })

  it('reports a failed local sign from the risk popover confirmation', async () => {
    const wallet = createSignPsbtWallet()
    wallet.signPsbtV2.mockRejectedValueOnce(new Error('signer unavailable'))
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => expect(result.current.showLoading).toBe(false))

    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.onRiskPopoverConfirm()
    })
    expect(outcome).toBe(false)
    expect(approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('retains a pasted external signature when the website safety guard rejects it', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    const { approval, store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ReadonlyKeyring,
      })
    )
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    act(() => {
      result.current.setReadonlySignedPsbtHex('externally-signed-psbt')
    })

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'late scammer warning')
      )
      await Promise.resolve()
    })
    expect(result.current.isBlocked).toBe(true)

    act(() => {
      result.current.onClickSign()
    })

    expect(result.current.readonlySignedPsbtHex).toBe('externally-signed-psbt')
    expect(result.current.signedCount).toBe(0)
    expect(approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('reserves an externally signed P2MR send before confirmation and carries its identity and claim', async () => {
    const wallet = createSignPsbtWallet()
    const handleConfirm = vi.fn()
    const { approval, store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ReadonlyKeyring,
      })
    )
    const toSignData: ToSignData = {
      psbtHex: 'unsigned-send',
      toSignInputs: [],
      qbitBroadcastIdentity: SEND_IDENTITY,
    }
    wallet.reserveExternallySignedQbitSend.mockResolvedValueOnce({
      psbtHex: 'externally-signed-send',
      qbitBroadcastIdentity: SEND_IDENTITY,
      qbitSendBroadcastClaim: SEND_CLAIM,
    })
    const { result } = renderHook(
      () => useSignPsbtLogic(createSendProps(toSignData, handleConfirm)),
      { wrapper }
    )
    expect(result.current.websiteCheckStatus).toBe('clear')

    act(() => {
      result.current.setReadonlySignedPsbtHex('externally-signed-send')
    })
    await act(async () => {
      await result.current.onClickSign()
    })

    // The readonly signer hands back only the pasted bytes, which never pass
    // through signPsbtV2 and the reservation it registers for a local send.
    // The wallet reserves the request's inputs from these bytes instead,
    // before the confirm screen sees them, and the result reaches it with the
    // same identity and claim a local signer would return, so the send is
    // retained, broadcast, proven, and released exactly like a local one.
    expect(wallet.reserveExternallySignedQbitSend).toHaveBeenCalledTimes(1)
    expect(wallet.reserveExternallySignedQbitSend).toHaveBeenCalledWith(
      toSignData,
      'externally-signed-send'
    )
    expect(handleConfirm).toHaveBeenCalledTimes(1)
    expect(handleConfirm).toHaveBeenCalledWith([
      {
        psbtHex: 'externally-signed-send',
        qbitBroadcastIdentity: SEND_IDENTITY,
        qbitSendBroadcastClaim: SEND_CLAIM,
      },
    ])
    expect(result.current.readonlySignedPsbtHex).toBe('')
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    expect(approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('keeps pasted external bytes out of confirmation when the wallet refuses to reserve them', async () => {
    const wallet = createSignPsbtWallet()
    const handleConfirm = vi.fn()
    const { store, tools, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ReadonlyKeyring,
      })
    )
    // Bytes for another transaction than the one the wallet built, or inputs
    // another send already reserved: the wallet registers nothing and the
    // bytes must not reach the confirm screen without a reservation.
    wallet.reserveExternallySignedQbitSend.mockRejectedValueOnce(
      new Error('signed transaction does not match the approved transaction')
    )
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createSendProps(
            { psbtHex: 'unsigned-send', toSignInputs: [], qbitBroadcastIdentity: SEND_IDENTITY },
            handleConfirm
          )
        ),
      { wrapper }
    )

    act(() => {
      result.current.setReadonlySignedPsbtHex('externally-signed-other-send')
    })
    let outcome: boolean | undefined
    await act(async () => {
      outcome = await result.current.onClickSign()
    })

    expect(outcome).toBe(false)
    expect(handleConfirm).not.toHaveBeenCalled()
    expect(tools.toastError).toHaveBeenCalledWith(
      'signed transaction does not match the approved transaction'
    )
    expect(result.current.signedCount).toBe(0)
    // The paste stays so the user can correct it without leaving the screen.
    expect(result.current.readonlySignedPsbtHex).toBe('externally-signed-other-send')
  })

  it('does not reserve a provider signing request from an external account', async () => {
    const wallet = createSignPsbtWallet()
    const { approval, store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ReadonlyKeyring,
      })
    )
    // A dapp request: the background locked its inputs when the approval was
    // created and promotes or releases that lock itself once this resolves.
    const toSignData: ToSignData = {
      psbtHex: 'unsigned-provider-psbt',
      toSignInputs: [],
      qbitBroadcastIdentity: SEND_IDENTITY,
      providerContext: {
        origin: 'https://example.test',
        account: 'qbrt1zsender',
        chain: ChainType.QBIT_REGTEST,
        network: 'regtest',
      },
    }
    const { result } = renderHook(() => useSignPsbtLogic(createProps([toSignData])), { wrapper })
    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))

    act(() => {
      result.current.setReadonlySignedPsbtHex('externally-signed-provider-psbt')
    })
    await act(async () => {
      await result.current.onClickSign()
    })

    expect(wallet.reserveExternallySignedQbitSend).not.toHaveBeenCalled()
    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, [
      { psbtHex: 'externally-signed-provider-psbt', qbitBroadcastIdentity: SEND_IDENTITY },
    ])
  })

  it('reserves a cold-wallet signed P2MR send before confirmation and carries its identity and claim', async () => {
    const wallet = createSignPsbtWallet()
    const handleConfirm = vi.fn()
    const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ColdWalletKeyring,
      })
    )
    const toSignData: ToSignData = {
      psbtHex: 'unsigned-send',
      toSignInputs: [],
      qbitBroadcastIdentity: SEND_IDENTITY,
    }
    wallet.reserveExternallySignedQbitSend.mockResolvedValueOnce({
      psbtHex: 'cold-signed-send',
      qbitBroadcastIdentity: SEND_IDENTITY,
      qbitSendBroadcastClaim: SEND_CLAIM,
    })
    const { result } = renderHook(
      () => useSignPsbtLogic(createSendProps(toSignData, handleConfirm)),
      { wrapper }
    )

    await act(async () => {
      await result.current.onClickSign()
    })
    expect(result.current.isColdWalletSigning).toBe(true)

    // The cold-wallet signer hands back the scanned PSBT hex as a bare string.
    await act(async () => {
      await result.current.onColdWalletSigningSuccess('cold-signed-send')
    })

    expect(wallet.reserveExternallySignedQbitSend).toHaveBeenCalledWith(
      toSignData,
      'cold-signed-send'
    )
    expect(handleConfirm).toHaveBeenCalledWith([
      {
        psbtHex: 'cold-signed-send',
        qbitBroadcastIdentity: SEND_IDENTITY,
        qbitSendBroadcastClaim: SEND_CLAIM,
      },
    ])
    expect(result.current.isColdWalletSigning).toBe(false)
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
  })

  it('hands a cold-wallet signature to a provider approval as signed data, not as the bare string', async () => {
    const wallet = createSignPsbtWallet()
    const { approval, store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ColdWalletKeyring,
      })
    )
    // A dapp request: the background locked its inputs at approval, so the
    // wallet reserves nothing here, but the scanned hex must still reach the
    // approval as the signed data whose `psbtHex` the background reads.
    const toSignData: ToSignData = {
      psbtHex: 'unsigned-provider-psbt',
      toSignInputs: [],
      qbitBroadcastIdentity: SEND_IDENTITY,
      providerContext: {
        origin: 'https://example.test',
        account: 'qbrt1zsender',
        chain: ChainType.QBIT_REGTEST,
        network: 'regtest',
      },
    }
    const { result } = renderHook(() => useSignPsbtLogic(createProps([toSignData])), { wrapper })
    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))

    await act(async () => {
      await result.current.onClickSign()
    })
    expect(result.current.isColdWalletSigning).toBe(true)
    await act(async () => {
      await result.current.onColdWalletSigningSuccess('cold-signed-provider-psbt')
    })

    expect(wallet.reserveExternallySignedQbitSend).not.toHaveBeenCalled()
    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, [
      { psbtHex: 'cold-signed-provider-psbt', qbitBroadcastIdentity: SEND_IDENTITY },
    ])
    expect(result.current.isColdWalletSigning).toBe(false)
  })

  it('releases the reservation when the website guard changes before an externally signed send is handed off', async () => {
    const wallet = createSignPsbtWallet()
    const handleConfirm = vi.fn()
    let settleReservation: ((data: SignedData) => void) | undefined
    wallet.reserveExternallySignedQbitSend.mockReturnValueOnce(
      new Promise<SignedData>(resolve => {
        settleReservation = resolve
      })
    )
    const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ReadonlyKeyring,
      })
    )
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createSendProps(
            { psbtHex: 'unsigned-send', toSignInputs: [], qbitBroadcastIdentity: SEND_IDENTITY },
            handleConfirm
          )
        ),
      { wrapper }
    )

    act(() => {
      result.current.setReadonlySignedPsbtHex('externally-signed-send')
    })
    let outcome: Promise<boolean> | undefined
    act(() => {
      outcome = result.current.onClickSign()
    })
    expect(wallet.reserveExternallySignedQbitSend).toHaveBeenCalledTimes(1)

    // The guard generation moves on while the controller is still
    // registering the claim.
    act(() => {
      result.current.onRetryWebsiteCheck()
    })
    let handedOff: boolean | undefined
    await act(async () => {
      settleReservation?.({
        psbtHex: 'externally-signed-send',
        qbitBroadcastIdentity: SEND_IDENTITY,
        qbitSendBroadcastClaim: SEND_CLAIM,
      })
      handedOff = await outcome
    })

    // The handoff is refused and the bytes are discarded, so nothing could
    // retry or abandon them afterwards: the claim just registered for them
    // is released here instead of reserving the inputs until a restart.
    expect(handedOff).toBe(false)
    expect(handleConfirm).not.toHaveBeenCalled()
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(SEND_CLAIM)
  })

  it('releases the reservation when the website guard changes before a cold-wallet signed send is handed off', async () => {
    const wallet = createSignPsbtWallet()
    const handleConfirm = vi.fn()
    let settleReservation: ((data: SignedData) => void) | undefined
    wallet.reserveExternallySignedQbitSend.mockReturnValueOnce(
      new Promise<SignedData>(resolve => {
        settleReservation = resolve
      })
    )
    const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(
      accountActions.setCurrent({
        ...store.getState().accounts.current,
        type: KeyringType.ColdWalletKeyring,
      })
    )
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createSendProps(
            { psbtHex: 'unsigned-send', toSignInputs: [], qbitBroadcastIdentity: SEND_IDENTITY },
            handleConfirm
          )
        ),
      { wrapper }
    )
    await act(async () => {
      await result.current.onClickSign()
    })
    expect(result.current.isColdWalletSigning).toBe(true)

    let handoff: Promise<void> | undefined
    act(() => {
      handoff = result.current.onColdWalletSigningSuccess('cold-signed-send')
    })
    expect(wallet.reserveExternallySignedQbitSend).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.onRetryWebsiteCheck()
    })
    await act(async () => {
      settleReservation?.({
        psbtHex: 'cold-signed-send',
        qbitBroadcastIdentity: SEND_IDENTITY,
        qbitSendBroadcastClaim: SEND_CLAIM,
      })
      await handoff
    })

    expect(handleConfirm).not.toHaveBeenCalled()
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(SEND_CLAIM)
  })

  it('releases the claim minted by local signing when the website guard changes before the handoff', async () => {
    const wallet = createSignPsbtWallet()
    const handleConfirm = vi.fn()
    let settleSign: ((data: SignedData) => void) | undefined
    wallet.signPsbtV2.mockReturnValueOnce(
      new Promise<SignedData>(resolve => {
        settleSign = resolve
      })
    )
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createSendProps(
            { psbtHex: 'unsigned-send', toSignInputs: [], qbitBroadcastIdentity: SEND_IDENTITY },
            handleConfirm
          )
        ),
      { wrapper }
    )
    await waitFor(() => expect(result.current.showLoading).toBe(false))

    let outcome: Promise<boolean> | undefined
    act(() => {
      outcome = result.current.onClickSign()
    })
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.onRetryWebsiteCheck()
    })
    let handedOff: boolean | undefined
    await act(async () => {
      settleSign?.({
        psbtHex: 'signed-send',
        qbitBroadcastIdentity: SEND_IDENTITY,
        qbitSendBroadcastClaim: SEND_CLAIM,
      })
      handedOff = await outcome
    })

    // The signature is spent, so the attempt is not reported as retryable,
    // but the bytes never reach the confirm screen: the claim signing
    // registered for them is released the same way.
    expect(handedOff).toBe(true)
    expect(handleConfirm).not.toHaveBeenCalled()
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledTimes(1)
    expect(wallet.releaseQbitSendBroadcastClaim).toHaveBeenCalledWith(SEND_CLAIM)
  })

  it('leaves a provider claim to its approval when the guard refuses the handoff', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    let settleSign: ((data: SignedData) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    wallet.signPsbtV2.mockReturnValueOnce(
      new Promise<SignedData>(resolve => {
        settleSign = resolve
      })
    )
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const providerClaim: QbitSendBroadcastClaim = { ...SEND_CLAIM, origin: 'https://example.test' }
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            {
              psbtHex: 'provider-send',
              toSignInputs: [],
              qbitBroadcastIdentity: SEND_IDENTITY,
              qbitSendBroadcastClaim: providerClaim,
              providerContext: {
                origin: 'https://example.test',
                account: 'qbrt1zsender',
                chain: ChainType.QBIT_REGTEST,
                network: 'regtest',
              },
            },
          ])
        ),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    let outcome: Promise<boolean> | undefined
    act(() => {
      outcome = result.current.onClickSign()
    })
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)
    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('example.test', 'example.test', 'late scammer warning')
      )
      await Promise.resolve()
    })
    expect(result.current.isBlocked).toBe(true)
    await act(async () => {
      settleSign?.({
        psbtHex: 'signed-provider-send',
        qbitBroadcastIdentity: SEND_IDENTITY,
        qbitSendBroadcastClaim: providerClaim,
      })
      await outcome
    })

    // The approval is rejected from here and the background releases the
    // claim with the provider request it is filed under; the signer must not
    // release it itself.
    expect(approval.resolveApproval).not.toHaveBeenCalled()
    expect(wallet.releaseQbitSendBroadcastClaim).not.toHaveBeenCalled()
  })

  it('allows an unverified-site override to finish signing when its check generation is unchanged', async () => {
    vi.useFakeTimers()
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValueOnce(new Promise(() => undefined))
    wallet.signPsbtV2.mockResolvedValueOnce({ psbtHex: 'signed-single-psbt' })
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    await act(async () => {
      result.current.onClickSign()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, [
      { psbtHex: 'signed-single-psbt' },
    ])
  })

  it('does not release a pending local signature after the website check is retried', async () => {
    vi.useFakeTimers()
    let settleFirstCheck: ((result: WebsiteSafetyResult) => void) | undefined
    let settleSign: ((signedData: { psbtHex: string }) => void) | undefined
    const firstCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleFirstCheck = resolve
    })
    const pendingSign = new Promise<{ psbtHex: string }>(resolve => {
      settleSign = resolve
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite
      .mockReturnValueOnce(firstCheck)
      .mockReturnValueOnce(new Promise(() => undefined))
    wallet.signPsbtV2.mockReturnValueOnce(pendingSign)
    const { approval, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    act(() => {
      result.current.onClickSign()
    })
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.onRetryWebsiteCheck()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(wallet.checkWebsite).toHaveBeenCalledTimes(2)

    await act(async () => {
      settleFirstCheck?.(
        createBlockedWebsiteResult(
          'example.test',
          'example.test',
          'superseded scammer warning'
        )
      )
      await Promise.resolve()
    })
    expect(result.current.isBlocked).toBe(false)

    await act(async () => {
      settleSign?.({ psbtHex: 'signed-single-psbt' })
      await Promise.resolve()
    })

    expect(result.current.signedCount).toBe(0)
    expect(approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('does not let a stale local-sign rejection overwrite its successful replacement', async () => {
    vi.useFakeTimers()
    let rejectFirstSign: ((reason: Error) => void) | undefined
    const firstSign = new Promise<{ psbtHex: string }>((_, reject) => {
      rejectFirstSign = reject
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValue(new Promise(() => undefined))
    wallet.signPsbtV2
      .mockReturnValueOnce(firstSign)
      .mockResolvedValueOnce({ psbtHex: 'replacement-signature' })
    const { tools, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            { psbtHex: 'first-psbt', toSignInputs: [] },
            { psbtHex: 'second-psbt', toSignInputs: [] },
          ])
        ),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
      result.current.multiSignList[0].onClick()
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      result.current.onClickSign()
    })
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.onRetryWebsiteCheck()
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
      result.current.onClickSign()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(2)
    expect(result.current.signedCount).toBe(1)
    expect(result.current.multiSignList[0].buttonPreset).toBe('approval')

    await act(async () => {
      rejectFirstSign?.(new Error('stale signing failure'))
      await Promise.resolve()
    })

    expect(result.current.signedCount).toBe(1)
    expect(result.current.multiSignList[0].buttonPreset).toBe('approval')
    expect(tools.toastError).not.toHaveBeenCalled()
  })

  it('ignores a quick-sign rejection after the website check is retried', async () => {
    vi.useFakeTimers()
    let rejectSign: ((reason: Error) => void) | undefined
    const pendingSign = new Promise<{ psbtHex: string }>((_, reject) => {
      rejectSign = reject
    })
    const wallet = createSignPsbtWallet()
    wallet.checkWebsite.mockReturnValue(new Promise(() => undefined))
    wallet.signLocalBatchPsbt.mockReturnValueOnce(pendingSign)
    const { tools, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () =>
        useSignPsbtLogic(
          createProps([
            { psbtHex: 'first-psbt', toSignInputs: [] },
            { psbtHex: 'second-psbt', toSignInputs: [] },
          ])
        ),
      { wrapper }
    )

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(PSBT_WEBSITE_CHECK_TIMEOUT_MS)
      await Promise.resolve()
    })

    let quickSign: Promise<void>
    act(() => {
      quickSign = result.current.onQuickMultiSign()
    })
    await act(async () => {
      vi.advanceTimersByTime(50)
      await vi.waitFor(() => expect(wallet.signLocalBatchPsbt).toHaveBeenCalled())
    })
    expect(wallet.signLocalBatchPsbt).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.onRetryWebsiteCheck()
      await Promise.resolve()
      await Promise.resolve()
      rejectSign?.(new Error('stale quick-sign failure'))
      await quickSign
    })

    expect(result.current.signedCount).toBe(0)
    expect(result.current.multiSignList[0].buttonPreset).toBe('primary')
    expect(tools.toastError).not.toHaveBeenCalled()
  })
})

describe('useSignPsbtLogic spend summary binding (#271)', () => {
  const ACCOUNT = 'qb1ztestaccount'
  const OTHER_ACCOUNT = 'qb1zsecondaccount'

  function decodedFor(account: string, netSpend: number): DecodedPsbt {
    return {
      ...DECODED_PSBT,
      spendSummary: {
        account,
        walletInputValue: 10_000,
        walletOutputValue: 10_000 - netSpend,
        netSpend,
        externalOutputValue: netSpend - 100,
        outputRoles: [],
        unrecognisedOutputCount: 0,
        unrecognisedOutputValue: 0,
        undecodableOutputCount: 0,
      },
    }
  }

  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('asks the background for the summary with the recipients the request names', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockResolvedValue(decodedFor(ACCOUNT, 1_100))
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const toSignData: ToSignData = {
      psbtHex: 'send-psbt',
      toSignInputs: [],
      action: {
        name: 'Send QBT',
        description: '',
        type: PsbtActionType.CUSTOM,
        details: [
          { label: 'To', value: 'qb1zrecipient', type: PsbtActionDetailType.ADDRESS },
          { label: 'Amount', value: 1_000, type: PsbtActionDetailType.SATOSHIS },
        ],
      },
    }
    const { result } = renderHook(() => useSignPsbtLogic(createProps([toSignData])), { wrapper })

    await waitFor(() =>
      expect(result.current.currentDecodedPsbt?.spendSummary.netSpend).toBe(1_100)
    )
    expect(wallet.decodePsbt).toHaveBeenCalledWith('send-psbt', 'https://example.test', {
      statedRecipients: ['qb1zrecipient'],
      suppliedByWebsite: false,
    })
  })

  it("reviews a website's own PSBT as supplied by it, and its sendQbit as the wallet's", async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockResolvedValue(decodedFor(ACCOUNT, 1_100))
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const providerContext = {
      origin: 'https://example.test',
      account: ACCOUNT,
      chain: ChainType.QBIT_REGTEST,
      network: 'regtest',
    } as ToSignData['providerContext']
    const signPsbt: ToSignData = { psbtHex: 'website-psbt', toSignInputs: [], providerContext }
    // The wallet built a sendQbit's PSBT and reserved its inputs at approval.
    const sendQbit: ToSignData = {
      ...signPsbt,
      qbitSendBroadcastClaim: { ...SEND_CLAIM, origin: 'https://example.test' },
    }
    const { result, rerender } = renderHook(
      ({ toSignData }) => useSignPsbtLogic(createProps([toSignData])),
      { wrapper, initialProps: { toSignData: sendQbit } }
    )

    await waitFor(() =>
      expect(result.current.currentDecodedPsbt?.spendSummary.netSpend).toBe(1_100)
    )
    expect(wallet.decodePsbt).toHaveBeenLastCalledWith('website-psbt', 'https://example.test', {
      statedRecipients: [],
      suppliedByWebsite: false,
    })

    // The same bytes from the website's signPsbt are reviewed again, not taken from the cache.
    rerender({ toSignData: signPsbt })
    await waitFor(() => expect(wallet.decodePsbt).toHaveBeenCalledTimes(2))
    expect(wallet.decodePsbt).toHaveBeenLastCalledWith('website-psbt', 'https://example.test', {
      statedRecipients: [],
      suppliedByWebsite: true,
    })
  })

  it('refuses a summary the background computed for another account instead of showing it', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockResolvedValue(decodedFor(OTHER_ACCOUNT, 1_100))
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() => expect(result.current.decodeError).toBe(true))
    expect(result.current.currentDecodedPsbt).toBeUndefined()
    expect(result.current.isValid).toBe(false)
    expect(result.current.showLoading).toBe(false)
  })

  it('adopts the background’s account when this screen lags it, then shows that account’s summary', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockResolvedValue(decodedFor(OTHER_ACCOUNT, 2_200))
    const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    wallet.getCurrentAccount.mockResolvedValue({
      ...store.getState().accounts.current,
      address: OTHER_ACCOUNT,
    })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )

    await waitFor(() =>
      expect(result.current.currentDecodedPsbt?.spendSummary.account).toBe(OTHER_ACCOUNT)
    )
    expect(store.getState().accounts.current.address).toBe(OTHER_ACCOUNT)
    expect(wallet.decodePsbt).toHaveBeenCalledTimes(2)
    expect(result.current.decodeError).toBe(false)
  })

  it('decodes again when the account changes and ignores the earlier account’s late summary', async () => {
    const wallet = createSignPsbtWallet()
    let resolveFirst: ((decoded: DecodedPsbt) => void) | undefined
    wallet.decodePsbt
      .mockImplementationOnce(
        () =>
          new Promise<DecodedPsbt>(resolve => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(decodedFor(OTHER_ACCOUNT, 2_200))
    const { store, wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )
    await waitFor(() => expect(wallet.decodePsbt).toHaveBeenCalledTimes(1))

    act(() => {
      store.dispatch(
        accountActions.setCurrent({
          ...store.getState().accounts.current,
          address: OTHER_ACCOUNT,
        })
      )
    })
    await waitFor(() =>
      expect(result.current.currentDecodedPsbt?.spendSummary.account).toBe(OTHER_ACCOUNT)
    )
    expect(wallet.decodePsbt).toHaveBeenCalledTimes(2)

    // The first account's decode finishes last; its summary must not replace
    // the one for the account that will sign.
    await act(async () => {
      resolveFirst?.(decodedFor(ACCOUNT, 1_100))
      await Promise.resolve()
    })
    expect(result.current.currentDecodedPsbt?.spendSummary).toMatchObject({
      account: OTHER_ACCOUNT,
      netSpend: 2_200,
    })
    expect(result.current.decodeError).toBe(false)
  })

  it('opens the risk review instead of signing when the background flags the fee', async () => {
    const wallet = createSignPsbtWallet()
    wallet.decodePsbt.mockResolvedValue({
      ...decodedFor(ACCOUNT, 1_544_100),
      risks: [
        {
          type: RiskType.HIGH_FEE_RATE,
          level: 'warning',
          title: 'High fee rate detected',
          desc: 'The fee is far above what this transaction needs.',
        },
      ],
    })
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'single-psbt', toSignInputs: [] }])),
      { wrapper }
    )
    await waitFor(() => expect(result.current.hasRisk).toBe(true))

    await act(async () => {
      await result.current.onClickSign()
    })
    expect(result.current.isPsbtRiskPopoverVisible).toBe(true)
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
  })

  it('opens the risk review for a fee flagged only as a share of the payout at a low rate', async () => {
    const wallet = createSignPsbtWallet()
    const decoded = decodedFor(ACCOUNT, 270_760)
    wallet.decodePsbt.mockResolvedValue({
      ...decoded,
      feeRate: 15,
      recommendedFeeRate: 9,
      shouldWarnFeeRate: true,
      spendSummary: {
        ...decoded.spendSummary!,
        externalOutputValue: 100_000,
        feeAssessment: {
          fee: 170_760,
          feeRate: 15,
          amount: 100_000,
          recommendedFeeRate: 9,
          reasons: ['large_share_of_amount'],
        },
      },
      risks: [
        {
          type: RiskType.HIGH_FEE_RATE,
          level: 'warning',
          title: 'High fee rate detected',
          desc: 'The fee is far above what this transaction needs.',
        },
      ],
    })
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(
      () => useSignPsbtLogic(createProps([{ psbtHex: 'website-psbt', toSignInputs: [] }])),
      { wrapper }
    )
    await waitFor(() => expect(result.current.hasRisk).toBe(true))

    await act(async () => {
      await result.current.onClickSign()
    })
    expect(result.current.isPsbtRiskPopoverVisible).toBe(true)
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
  })
})

describe('useSignPsbtLogic quick multi-sign of a flagged local batch (#367)', () => {
  const ACCOUNT = 'qb1ztestaccount'
  const OTHER_ACCOUNT = 'qb1zsecondaccount'
  const HIGH_FEE_RISK = {
    type: RiskType.HIGH_FEE_RATE,
    level: 'warning' as const,
    title: 'High fee rate detected',
    desc: 'The fee is far above what this transaction needs.',
  }
  const UNRECOGNISED_OUTPUT_RISK = {
    type: RiskType.UNRECOGNISED_OUTPUT,
    level: 'danger' as const,
    title: 'Unrecognised output',
    desc: 'An output pays a script that is neither yours nor the named recipient.',
  }
  const BATCH: ToSignData[] = [
    { psbtHex: 'clean-psbt', toSignInputs: [] },
    { psbtHex: 'high-fee-psbt', toSignInputs: [] },
    { psbtHex: 'unrecognised-output-psbt', toSignInputs: [] },
  ]

  /** The background's analysis of BATCH: a 400x fee and an unrecognised output beside a clean PSBT. */
  function flaggedSummary(account = ACCOUNT): LocalPsbtSummary {
    const summary = localSummaryFor(BATCH, account)
    summary.items[1] = { ...summary.items[1]!, feeRate: '400.00', risks: [HIGH_FEE_RISK] }
    summary.items[2] = { ...summary.items[2]!, risks: [UNRECOGNISED_OUTPUT_RISK] }
    return summary
  }

  function renderBatch(wallet: ReturnType<typeof createSignPsbtWallet>) {
    const harness = createHookTestHarness({ wallet: wallet as any })
    const rendered = renderHook(() => useSignPsbtLogic(createProps(BATCH)), {
      wrapper: harness.wrapper,
    })
    return { ...harness, ...rendered }
  }

  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('names the flagged PSBTs and signs none of the batch before an explicit confirmation', async () => {
    const wallet = createSignPsbtWallet()
    wallet.analyzeLocalPsbts.mockResolvedValue(flaggedSummary())
    wallet.signLocalBatchPsbt.mockImplementation(async (toSignData: ToSignData) => ({
      psbtHex: `signed-${toSignData.psbtHex}`,
    }))
    const { approval, result } = renderBatch(wallet)
    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))
    await waitFor(() => expect(result.current.batchRiskIndexes).toEqual([1, 2]))
    expect(result.current.multiSignList.map(item => item.psbtInfo?.risks.length)).toEqual([0, 1, 1])

    await act(async () => {
      await result.current.onQuickMultiSign()
    })

    expect(wallet.signLocalBatchPsbt).not.toHaveBeenCalled()
    expect(wallet.signPsbtV2).not.toHaveBeenCalled()
    expect(result.current.batchRiskReview?.items.map(item => item.risks)).toEqual([
      [],
      [HIGH_FEE_RISK],
      [UNRECOGNISED_OUTPUT_RISK],
    ])

    await act(async () => {
      await result.current.onBatchRiskConfirm()
    })

    // Each PSBT carries only the risks the user confirmed for it; the wallet
    // reviews its bytes again and refuses any other.
    expect(wallet.signLocalBatchPsbt.mock.calls).toEqual([
      [BATCH[0], { account: ACCOUNT, chain: ChainType.QBIT_REGTEST, confirmedRisks: [] }],
      [
        BATCH[1],
        {
          account: ACCOUNT,
          chain: ChainType.QBIT_REGTEST,
          confirmedRisks: [RiskType.HIGH_FEE_RATE],
        },
      ],
      [
        BATCH[2],
        {
          account: ACCOUNT,
          chain: ChainType.QBIT_REGTEST,
          confirmedRisks: [RiskType.UNRECOGNISED_OUTPUT],
        },
      ],
    ])
    expect(result.current.batchRiskReview).toBeNull()
    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, [
      { psbtHex: 'signed-clean-psbt' },
      { psbtHex: 'signed-high-fee-psbt' },
      { psbtHex: 'signed-unrecognised-output-psbt' },
    ])
  })

  it('analyzes the batch again at quick-sign time instead of trusting the summary on screen', async () => {
    const wallet = createSignPsbtWallet()
    wallet.analyzeLocalPsbts
      .mockResolvedValueOnce(localSummaryFor(BATCH))
      .mockResolvedValueOnce(flaggedSummary())
    const { result } = renderBatch(wallet)
    await waitFor(() => expect(result.current.localPsbtSummary).not.toBeNull())
    expect(result.current.batchRiskIndexes).toEqual([])

    await act(async () => {
      await result.current.onQuickMultiSign()
    })

    expect(wallet.analyzeLocalPsbts).toHaveBeenCalledTimes(2)
    expect(wallet.analyzeLocalPsbts).toHaveBeenLastCalledWith(BATCH)
    expect(wallet.signLocalBatchPsbt).not.toHaveBeenCalled()
    expect(result.current.batchRiskReview).not.toBeNull()
    expect(result.current.batchRiskIndexes).toEqual([1, 2])
  })

  it('signs nothing once the review is closed, and a repeated confirm signs the batch once', async () => {
    const wallet = createSignPsbtWallet()
    wallet.analyzeLocalPsbts.mockResolvedValue(flaggedSummary())
    wallet.signLocalBatchPsbt.mockImplementation(async (toSignData: ToSignData) => ({
      psbtHex: `signed-${toSignData.psbtHex}`,
    }))
    const { result } = renderBatch(wallet)
    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))

    await act(async () => {
      await result.current.onQuickMultiSign()
    })
    expect(result.current.batchRiskReview).not.toBeNull()
    act(() => {
      result.current.onBatchRiskClose()
    })
    await act(async () => {
      await result.current.onBatchRiskConfirm()
    })
    expect(result.current.batchRiskReview).toBeNull()
    expect(wallet.signLocalBatchPsbt).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.onQuickMultiSign()
    })
    // Two clicks before the popover closes: the review is consumed by the first.
    await act(async () => {
      const confirm = result.current.onBatchRiskConfirm
      await Promise.all([confirm(), confirm()])
    })
    expect(wallet.signLocalBatchPsbt).toHaveBeenCalledTimes(BATCH.length)
  })

  it('refuses to quick-sign a batch the background analyzed for another account', async () => {
    const wallet = createSignPsbtWallet()
    wallet.analyzeLocalPsbts
      .mockResolvedValueOnce(localSummaryFor(BATCH))
      .mockResolvedValue(localSummaryFor(BATCH, OTHER_ACCOUNT))
    const { result, store, tools } = renderBatch(wallet)
    await waitFor(() => expect(result.current.localPsbtSummary).not.toBeNull())
    wallet.getCurrentAccount.mockResolvedValue({
      ...store.getState().accounts.current,
      address: OTHER_ACCOUNT,
    })

    await act(async () => {
      await result.current.onQuickMultiSign()
    })

    expect(wallet.signLocalBatchPsbt).not.toHaveBeenCalled()
    expect(tools.toastError).toHaveBeenCalledWith('multisign_account_changed')
    // The screen adopts the background's account, whose batch is analyzed again.
    await waitFor(() => expect(store.getState().accounts.current.address).toBe(OTHER_ACCOUNT))
    await waitFor(() => expect(result.current.localPsbtSummary?.account).toBe(OTHER_ACCOUNT))
  })

  it('analyzes again when the account changes and ignores the earlier account’s late analysis', async () => {
    const wallet = createSignPsbtWallet()
    let resolveFirst: ((summary: LocalPsbtSummary) => void) | undefined
    wallet.analyzeLocalPsbts
      .mockImplementationOnce(
        () =>
          new Promise<LocalPsbtSummary>(resolve => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(localSummaryFor(BATCH, OTHER_ACCOUNT))
    const { result, store } = renderBatch(wallet)
    await waitFor(() => expect(wallet.analyzeLocalPsbts).toHaveBeenCalledTimes(1))

    act(() => {
      store.dispatch(
        accountActions.setCurrent({
          ...store.getState().accounts.current,
          address: OTHER_ACCOUNT,
        })
      )
    })
    await waitFor(() => expect(result.current.localPsbtSummary?.account).toBe(OTHER_ACCOUNT))
    expect(wallet.analyzeLocalPsbts).toHaveBeenCalledTimes(2)

    // The first account's flagged analysis finishes last; it must not
    // replace the one for the account that will sign.
    await act(async () => {
      resolveFirst?.(flaggedSummary(ACCOUNT))
      await Promise.resolve()
    })
    expect(result.current.localPsbtSummary?.account).toBe(OTHER_ACCOUNT)
    expect(result.current.batchRiskIndexes).toEqual([])
  })

  it('signs only what is left when a refused PSBT is quick-signed again', async () => {
    const wallet = createSignPsbtWallet()
    wallet.signLocalBatchPsbt.mockImplementation(async (toSignData: ToSignData) => ({
      psbtHex: `signed-${toSignData.psbtHex}`,
    }))
    // The wallet's review of the last PSBT at signing time differs from the
    // batch analysis (its fee quote was refreshed), so it is refused once.
    wallet.signLocalBatchPsbt
      .mockImplementationOnce(async (toSignData: ToSignData) => ({
        psbtHex: `signed-${toSignData.psbtHex}`,
      }))
      .mockImplementationOnce(async (toSignData: ToSignData) => ({
        psbtHex: `signed-${toSignData.psbtHex}`,
      }))
      .mockRejectedValueOnce(new Error('The transaction has a risk that was not confirmed'))
    const { approval, result } = renderBatch(wallet)
    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))

    await act(async () => {
      await result.current.onQuickMultiSign()
    })
    expect(wallet.signLocalBatchPsbt).toHaveBeenCalledTimes(3)
    expect(result.current.signedCount).toBe(2)
    expect(approval.resolveApproval).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.onQuickMultiSign()
    })
    expect(wallet.signLocalBatchPsbt).toHaveBeenCalledTimes(4)
    expect(wallet.signLocalBatchPsbt).toHaveBeenLastCalledWith(BATCH[2], expect.anything())
    expect(approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, [
      { psbtHex: 'signed-clean-psbt' },
      { psbtHex: 'signed-high-fee-psbt' },
      { psbtHex: 'signed-unrecognised-output-psbt' },
    ])
  })

  it('keeps the analysis on screen when quick-sign’s own analysis fails', async () => {
    const wallet = createSignPsbtWallet()
    let resolveFirst: ((summary: LocalPsbtSummary) => void) | undefined
    wallet.analyzeLocalPsbts
      .mockImplementationOnce(
        () =>
          new Promise<LocalPsbtSummary>(resolve => {
            resolveFirst = resolve
          })
      )
      .mockRejectedValueOnce(new Error('The network changed while the PSBTs were analyzed'))
    const { result, tools } = renderBatch(wallet)
    await waitFor(() => expect(wallet.analyzeLocalPsbts).toHaveBeenCalledTimes(1))

    await act(async () => {
      await result.current.onQuickMultiSign()
    })
    expect(tools.toastError).toHaveBeenCalledWith(
      'The network changed while the PSBTs were analyzed'
    )
    expect(wallet.signLocalBatchPsbt).not.toHaveBeenCalled()

    await act(async () => {
      resolveFirst?.(flaggedSummary())
      await Promise.resolve()
    })
    expect(result.current.batchRiskIndexes).toEqual([1, 2])
  })

  it('closes a batch review once the account changes, and its confirm signs nothing', async () => {
    const wallet = createSignPsbtWallet()
    wallet.analyzeLocalPsbts.mockResolvedValue(flaggedSummary())
    const { result, store } = renderBatch(wallet)
    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))
    await act(async () => {
      await result.current.onQuickMultiSign()
    })
    expect(result.current.batchRiskReview).not.toBeNull()

    act(() => {
      store.dispatch(
        accountActions.setCurrent({
          ...store.getState().accounts.current,
          address: OTHER_ACCOUNT,
        })
      )
    })
    expect(result.current.batchRiskReview).toBeNull()

    // Switching back does not reopen the earlier account's review.
    act(() => {
      store.dispatch(
        accountActions.setCurrent({ ...store.getState().accounts.current, address: ACCOUNT })
      )
    })
    expect(result.current.batchRiskReview).toBeNull()
    await act(async () => {
      await result.current.onBatchRiskConfirm()
    })
    expect(wallet.signLocalBatchPsbt).not.toHaveBeenCalled()
  })
})
