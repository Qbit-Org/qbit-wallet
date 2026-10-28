import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  DecodedPsbt,
  KeyringType,
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

const EMPTY_LOCAL_SUMMARY = {
  totalFee: 0,
  totalInput: 0,
  completedCount: 0,
  hasSighashNone: false,
  parseErrorCount: 0,
  hasAssets: false,
  items: [],
}

function createSignPsbtWallet() {
  return {
    ...createWalletMock(),
    checkWebsite: vi.fn().mockResolvedValue(SAFE_WEBSITE_RESULT),
    getConnectedSites: vi.fn().mockResolvedValue([]),
    decodePsbt: vi.fn().mockResolvedValue(DECODED_PSBT),
    analyzeLocalPsbts: vi.fn().mockResolvedValue(EMPTY_LOCAL_SUMMARY),
    updateConnectSite: vi.fn().mockResolvedValue(undefined),
    signPsbtV2: vi.fn(),
    reserveExternallySignedQbitSend: vi.fn(),
    releaseQbitSendBroadcastClaim: vi.fn().mockResolvedValue(true),
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
    expect(wallet.decodePsbt).toHaveBeenCalledWith(toSignData.psbtHex, 'https://example.test')
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
    wallet.signPsbtV2.mockReturnValueOnce(pendingSign)
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
      await Promise.resolve()
      await Promise.resolve()
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
      settleSign?.({ psbtHex: 'signed-first-psbt' })
      await quickSign
    })

    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)
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
    wallet.signPsbtV2.mockReturnValueOnce(pendingSign)
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
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(wallet.signPsbtV2).toHaveBeenCalledTimes(1)

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
