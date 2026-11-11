import { act, renderHook, waitFor } from '@testing-library/react'
import {
  createBlockedWebsiteResult,
  createClearWebsiteResult,
  createTrustedWebsiteResult,
  createUnverifiedWebsiteResult,
  type WebsiteSafetyResult,
} from '@qbit/wallet-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useConnectWebsiteCheck } from '../../src/ui-hooks/useConnectWebsiteCheck'
import { createHookTestHarness, createWalletMock } from './testHelpers'

describe('useConnectWebsiteCheck', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps a detector rejection to an actionable unverified verdict', async () => {
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockRejectedValue(new Error('detector unavailable')),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://example.com', 100), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.status).toBe('unverified')
    })

    expect(result.current.result?.verdict).toMatchObject({
      status: 'unverified',
      reason: 'detector-failure',
    })
  })

  it('maps a malformed detector response to an actionable unverified verdict', async () => {
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockResolvedValue({
        verdict: { status: 'clear' },
        allowQuickMultiSign: false,
      }),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://example.com', 100), {
      wrapper,
    })

    await waitFor(() => expect(result.current.status).toBe('unverified'))
    expect(result.current.result?.verdict).toMatchObject({
      status: 'unverified',
      reason: 'detector-failure',
    })
  })

  it('marks the official website trusted from its trusted verdict', async () => {
    const trustedResult = createTrustedWebsiteResult('qbit.org')
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockResolvedValue(trustedResult),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://qbit.org', 100), {
      wrapper,
    })

    expect(result.current.trusted).toBe(false)
    await waitFor(() => expect(result.current.status).toBe('clear'))
    expect(result.current.trusted).toBe(true)
    expect(result.current.result).toEqual(trustedResult)
  })

  it('does not mark a site trusted from a not-listed clear verdict', async () => {
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockResolvedValue(createClearWebsiteResult('example.com')),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://example.com', 100), {
      wrapper,
    })

    await waitFor(() => expect(result.current.status).toBe('clear'))
    expect(result.current.trusted).toBe(false)
  })

  it('maps a clear verdict with an unknown reason to an actionable unverified verdict', async () => {
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockResolvedValue({
        verdict: { status: 'clear', reason: 'official', hostname: 'qbit.org', warning: '' },
        allowQuickMultiSign: true,
      }),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://qbit.org', 100), {
      wrapper,
    })

    await waitFor(() => expect(result.current.status).toBe('unverified'))
    expect(result.current.result).toMatchObject({
      verdict: { status: 'unverified', reason: 'detector-failure' },
      allowQuickMultiSign: false,
    })
    expect(result.current.trusted).toBe(false)
  })

  it('does not reuse a clear verdict after the approval origin changes', async () => {
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi
        .fn()
        .mockResolvedValueOnce(createClearWebsiteResult('example.com'))
        .mockReturnValueOnce(new Promise(() => {})),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result, rerender } = renderHook(
      ({ origin }) => useConnectWebsiteCheck(origin, 100),
      { initialProps: { origin: 'https://example.com' }, wrapper }
    )

    await waitFor(() => expect(result.current.status).toBe('clear'))

    rerender({ origin: 'https://another.example' })

    expect(result.current.status).toBe('checking')
    expect(result.current.result).toBeUndefined()
  })

  it('times out a check that never settles', async () => {
    vi.useFakeTimers()
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn(() => new Promise(() => {})),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://example.com', 100), {
      wrapper,
    })

    expect(result.current.status).toBe('checking')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(result.current.status).toBe('unverified')
    expect(result.current.result?.verdict).toMatchObject({
      status: 'unverified',
      reason: 'timeout',
    })
  })

  it('upgrades a timeout when a blocked verdict arrives late', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockReturnValue(websiteCheck),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://blocked.example', 100), {
      wrapper,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.status).toBe('unverified')

    await act(async () => {
      settleCheck?.(
        createBlockedWebsiteResult('blocked.example', 'blocked.example', 'late blocked warning')
      )
      await Promise.resolve()
    })

    expect(result.current.status).toBe('blocked')
    expect(result.current.warning).toBe('late blocked warning')
  })

  it('does not silently promote a timeout when a clear verdict arrives late', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockReturnValue(websiteCheck),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://example.com', 100), {
      wrapper,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const timeoutWarning = result.current.warning

    await act(async () => {
      settleCheck?.(createClearWebsiteResult('example.com'))
      await Promise.resolve()
    })

    expect(result.current.status).toBe('unverified')
    expect(result.current.result?.verdict.reason).toBe('timeout')
    expect(result.current.warning).toBe(timeoutWarning)
  })

  it('does not trust the official website when its verdict arrives after a timeout', async () => {
    vi.useFakeTimers()
    let settleCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const websiteCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleCheck = resolve
    })
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockReturnValue(websiteCheck),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://qbit.org', 100), {
      wrapper,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    await act(async () => {
      settleCheck?.(createTrustedWebsiteResult('qbit.org'))
      await Promise.resolve()
    })

    expect(result.current.status).toBe('unverified')
    expect(result.current.result?.verdict.reason).toBe('timeout')
    expect(result.current.trusted).toBe(false)
  })

  it('preserves an explicit unverified detector result', async () => {
    const unverified = createUnverifiedWebsiteResult(
      'private-network',
      'Private network warning',
      'router.local'
    )
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi.fn().mockResolvedValue(unverified),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://router.local', 100), {
      wrapper,
    })

    await waitFor(() => expect(result.current.status).toBe('unverified'))
    expect(result.current.result).toEqual(unverified)
  })

  it('starts a clean retry and ignores a stale blocked result', async () => {
    vi.useFakeTimers()
    let settleFirstCheck: ((result: WebsiteSafetyResult) => void) | undefined
    const firstCheck = new Promise<WebsiteSafetyResult>(resolve => {
      settleFirstCheck = resolve
    })
    const wallet = {
      ...createWalletMock(),
      checkWebsite: vi
        .fn()
        .mockReturnValueOnce(firstCheck)
        .mockResolvedValueOnce(createClearWebsiteResult('example.com')),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => useConnectWebsiteCheck('https://example.com', 100), {
      wrapper,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(result.current.status).toBe('unverified')

    await act(async () => {
      result.current.retry()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('clear')
    expect(wallet.checkWebsite).toHaveBeenCalledTimes(2)

    await act(async () => {
      settleFirstCheck?.(
        createBlockedWebsiteResult('example.com', 'example.com', 'stale blocked warning')
      )
      await Promise.resolve()
    })
    expect(result.current.status).toBe('clear')
    expect(result.current.warning).toBe('')
  })
})
