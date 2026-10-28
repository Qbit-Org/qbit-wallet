import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SignMessageType,
  createBlockedWebsiteResult,
  createClearWebsiteResult,
  createUnverifiedWebsiteResult,
  type P2mrMessageProof,
  type WebsiteSafetyResult,
} from '@qbit/wallet-shared'
import {
  SIGN_MESSAGE_WEBSITE_CHECK_TIMEOUT_MS,
  useSignMessageLogic,
} from '../../src/ui-hooks/useSignMessageLogic'
import { createHookTestHarness, createWalletMock } from './testHelpers'

function p2mrProof(signatureByte = '44'): P2mrMessageProof {
  return {
    type: 'p2mr-message',
    version: 1,
    address: 'qbrt1zproof',
    message_hash: '11'.repeat(32),
    datasig_hash: '22'.repeat(32),
    domain: 'QbitDataSigPQC',
    message_domain: 'QbitWalletSignedMessage',
    algorithm: 'SLH-DSA-SHA2-128s-bounded30',
    proof_mode: 'p2mr-pubkey',
    pubkey: '33'.repeat(32),
    signature: signatureByte.repeat(4),
    leaf_version: 0xc0,
    leaf_script: '55',
    control_block: 'c1',
    p2mr_merkle_root: '66'.repeat(32),
  }
}

// The id ApprovalScreen read for the approval it renders.
const APPROVAL_ID = 'rendered-approval-id'

function messageProps(
  toSignMessages = [{ text: 'approval message', type: SignMessageType.P2MR }]
) {
  return {
    approvalId: APPROVAL_ID,
    params: {
      data: {
        toSignMessages,
      },
      session: {
        origin: 'https://dapp.example',
        icon: '',
        name: 'Example dApp',
      },
    },
  }
}

function walletWithSignMessage(signMessage: ReturnType<typeof vi.fn>) {
  return {
    ...createWalletMock(),
    signMessage,
    checkWebsite: vi.fn().mockResolvedValue(createClearWebsiteResult('dapp.example')),
    getConnectedSites: vi.fn().mockResolvedValue([]),
    updateConnectSite: vi.fn().mockResolvedValue(undefined),
  }
}

describe('useSignMessageLogic', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves a successful P2MR proof back to the provider approval', async () => {
    const proof = p2mrProof()
    const wallet = walletWithSignMessage(vi.fn().mockResolvedValue({ proof }))
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps()), {
      wrapper: harness.wrapper,
    })

    act(() => result.current.onClickSign())

    await waitFor(() => {
      expect(harness.approval.resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, [{ proof }])
    })
    expect(harness.approval.rejectApproval).not.toHaveBeenCalled()
  })

  it('rejects a failed local signature request without exposing the internal error', async () => {
    const signMessage = vi
      .fn()
      .mockRejectedValue(new Error('P2MR account leaf script metadata mismatch'))
    const wallet = walletWithSignMessage(signMessage)
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps()), {
      wrapper: harness.wrapper,
    })

    act(() => result.current.onClickSign())

    await waitFor(() => {
      expect(harness.approval.rejectApproval).toHaveBeenCalledTimes(1)
    })
    expect(harness.approval.rejectApproval.mock.calls[0]).toEqual([APPROVAL_ID])
    expect(harness.approval.resolveApproval).not.toHaveBeenCalled()
    expect(signMessage).toHaveBeenCalledTimes(1)
  })

  it('forwards a preflighted P2MR account binding and rejects an account-switch failure', async () => {
    const toSignMessage = {
      text: 'account-bound approval message',
      type: SignMessageType.P2MR,
      p2mrAccountAddress: 'qbrt1zpreflighted',
    }
    const signMessage = vi
      .fn()
      .mockRejectedValue(new Error('P2MR signing account changed after approval'))
    const wallet = walletWithSignMessage(signMessage)
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps([toSignMessage])), {
      wrapper: harness.wrapper,
    })

    act(() => result.current.onClickSign())

    await waitFor(() => {
      expect(harness.approval.rejectApproval).toHaveBeenCalledTimes(1)
    })
    expect(signMessage).toHaveBeenCalledWith(toSignMessage)
    expect(harness.approval.rejectApproval).toHaveBeenCalledWith(APPROVAL_ID)
    expect(harness.approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('rejects a failed batch once and stops signing later messages', async () => {
    const firstProof = p2mrProof('44')
    const signMessage = vi
      .fn()
      .mockResolvedValueOnce({ proof: firstProof })
      .mockRejectedValueOnce(new Error('internal keyring lookup failed'))
      .mockResolvedValueOnce({ proof: p2mrProof('66') })
    const wallet = walletWithSignMessage(signMessage)
    const harness = createHookTestHarness({ wallet: wallet as any })
    const props = messageProps([
      { text: 'first message', type: SignMessageType.P2MR },
      { text: 'second message', type: SignMessageType.P2MR },
      { text: 'third message', type: SignMessageType.P2MR },
    ])
    const { result } = renderHook(() => useSignMessageLogic(props), {
      wrapper: harness.wrapper,
    })

    await act(async () => {
      await result.current.onQuickMultiSign()
    })

    expect(signMessage).toHaveBeenCalledTimes(2)
    expect(result.current.signedCount).toBe(1)
    expect(harness.approval.rejectApproval).toHaveBeenCalledTimes(1)
    expect(harness.approval.rejectApproval.mock.calls[0]).toEqual([APPROVAL_ID])
    expect(harness.approval.resolveApproval).not.toHaveBeenCalled()
    expect(signMessage).not.toHaveBeenCalledWith(props.params.data.toSignMessages[2])
  })

  it('settles a detector failure as unverified instead of loading indefinitely', async () => {
    const wallet = walletWithSignMessage(vi.fn())
    wallet.checkWebsite.mockRejectedValueOnce(new Error('detector unavailable'))
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps()), {
      wrapper: harness.wrapper,
    })

    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('unverified'))
    expect(result.current.loading).toBe(false)
    expect(result.current.websiteCheckWarning).not.toBe('')
  })

  it('settles a stalled message website check as unverified', async () => {
    vi.useFakeTimers()
    const wallet = walletWithSignMessage(vi.fn())
    wallet.checkWebsite.mockReturnValueOnce(new Promise(() => undefined))
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps()), {
      wrapper: harness.wrapper,
    })

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(SIGN_MESSAGE_WEBSITE_CHECK_TIMEOUT_MS)
    })

    expect(result.current.websiteCheckStatus).toBe('unverified')
    expect(result.current.loading).toBe(false)
  })

  it('invalidates an in-flight message signature when a blocked verdict arrives late', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    let settleSign: ((result: { proof: P2mrMessageProof }) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const pendingSign = new Promise<{ proof: P2mrMessageProof }>(resolve => {
      settleSign = resolve
    })
    const signMessage = vi.fn().mockReturnValue(pendingSign)
    const wallet = walletWithSignMessage(signMessage)
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps()), {
      wrapper: harness.wrapper,
    })

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(SIGN_MESSAGE_WEBSITE_CHECK_TIMEOUT_MS)
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    act(() => result.current.onClickSign())
    expect(signMessage).toHaveBeenCalledTimes(1)

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('dapp.example', 'dapp.example', 'late blocked warning')
      )
      await Promise.resolve()
    })
    expect(result.current.websiteCheckStatus).toBe('blocked')

    await act(async () => {
      settleSign?.({ proof: p2mrProof() })
      await Promise.resolve()
    })

    expect(result.current.signedCount).toBe(0)
    expect(harness.approval.resolveApproval).not.toHaveBeenCalled()
  })

  it('keeps a timeout unverified when a clear message verdict arrives late', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = walletWithSignMessage(vi.fn())
    wallet.checkWebsite.mockReturnValueOnce(websiteCheck)
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps()), {
      wrapper: harness.wrapper,
    })

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(SIGN_MESSAGE_WEBSITE_CHECK_TIMEOUT_MS)
    })

    await act(async () => {
      settleCheck?.(createClearWebsiteResult('dapp.example'))
      await Promise.resolve()
    })

    expect(result.current.websiteCheckStatus).toBe('unverified')
    expect(result.current.websiteCheckWarning).toContain('timed out')
  })

  it('retries an unverified message check and accepts the fresh clear verdict', async () => {
    vi.useFakeTimers()
    const wallet = walletWithSignMessage(vi.fn())
    wallet.checkWebsite
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(createClearWebsiteResult('dapp.example'))
    const harness = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useSignMessageLogic(messageProps()), {
      wrapper: harness.wrapper,
    })

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(SIGN_MESSAGE_WEBSITE_CHECK_TIMEOUT_MS)
    })
    expect(result.current.websiteCheckStatus).toBe('unverified')

    await act(async () => {
      result.current.onRetryWebsiteCheck()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.websiteCheckStatus).toBe('clear')
    expect(wallet.checkWebsite).toHaveBeenCalledTimes(2)
  })

  it('does not restore quick-sign trust after the website check is retried', async () => {
    let settleTrustUpdate: (() => void) | undefined
    const pendingTrustUpdate = new Promise<void>(resolve => {
      settleTrustUpdate = resolve
    })
    const wallet = walletWithSignMessage(vi.fn())
    wallet.checkWebsite
      .mockResolvedValueOnce(createClearWebsiteResult('dapp.example'))
      .mockReturnValueOnce(new Promise(() => undefined))
    wallet.updateConnectSite.mockReturnValueOnce(pendingTrustUpdate)
    const harness = createHookTestHarness({ wallet: wallet as any })
    const props = messageProps([
      { text: 'first message', type: SignMessageType.P2MR },
      { text: 'second message', type: SignMessageType.P2MR },
    ])
    const { result } = renderHook(() => useSignMessageLogic(props), {
      wrapper: harness.wrapper,
    })

    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('clear'))

    let trustSite: Promise<void>
    act(() => {
      trustSite = result.current.onTrustSite()
    })
    expect(wallet.updateConnectSite).toHaveBeenCalledWith('https://dapp.example', {
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

  it('does not treat cached batch-sign trust as a safe verdict', async () => {
    const wallet = walletWithSignMessage(vi.fn())
    wallet.checkWebsite.mockResolvedValueOnce(
      createUnverifiedWebsiteResult(
        'private-network',
        'Private network warning',
        'router.local'
      )
    )
    wallet.getConnectedSites.mockResolvedValueOnce([
      { origin: 'https://dapp.example', allowQuickMultiSign: true },
    ])
    const harness = createHookTestHarness({ wallet: wallet as any })
    const props = messageProps([
      { text: 'first message', type: SignMessageType.P2MR },
      { text: 'second message', type: SignMessageType.P2MR },
    ])
    const { result } = renderHook(() => useSignMessageLogic(props), {
      wrapper: harness.wrapper,
    })

    await waitFor(() => expect(result.current.websiteCheckStatus).toBe('unverified'))

    expect(result.current.allowQuickMultiSign).toBe(false)
    expect(wallet.getConnectedSites).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.onTrustSite()
    })
    expect(wallet.updateConnectSite).not.toHaveBeenCalled()
  })
})
