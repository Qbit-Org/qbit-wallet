import { act, cleanup, renderHook } from '@testing-library/react'
import { BUS_METHODS } from '@qbit/wallet-shared'
import { afterEach, describe, expect, it } from 'vitest'

import { estimateSigningRemainingMs, useSigningProgress } from '../src/hooks/signing'
import { uiEventBus } from '../src/utils/eventBus'

const report = (event: unknown) =>
  act(() => {
    uiEventBus.emit(BUS_METHODS.QBIT_SIGNING_PROGRESS, event)
  })

afterEach(() => {
  cleanup()
})

describe('useSigningProgress (#171)', () => {
  it('shows nothing until a signing starts, then only that signing’s counts', () => {
    const { result } = renderHook(() => useSigningProgress())
    report({ progressId: 'early', signed: 1, total: 2, cached: 0 })
    expect(result.current.progress).toBeNull()

    let id = ''
    act(() => {
      id = result.current.start()
    })
    // The background accepts only ids of this shape.
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(result.current.progress).toEqual({
      transactionIndex: undefined,
      transactionCount: undefined,
    })

    report({ progressId: 'another-signing', signed: 1, total: 2, cached: 0 })
    expect(result.current.progress?.signed).toBeUndefined()
    report({ progressId: id, signed: 1, total: 2, cached: 0 })
    expect(result.current.progress).toMatchObject({ signed: 1, total: 2 })
  })

  it.each([
    ['a count above the total', { signed: 3, total: 2, cached: 0 }],
    ['a negative count', { signed: -1, total: 2, cached: 0 }],
    ['a fractional count', { signed: 1.5, total: 2, cached: 0 }],
    ['a count as text', { signed: '1', total: 2, cached: 0 }],
    ['a missing total', { signed: 1, cached: 0 }],
    ['a missing cached count', { signed: 2, total: 4 }],
    ['more cached than signed', { signed: 2, total: 4, cached: 3 }],
  ])('ignores %s', (_, counts) => {
    const { result } = renderHook(() => useSigningProgress())
    let id = ''
    act(() => {
      id = result.current.start()
    })
    report({ progressId: id, signed: 1, total: 4, cached: 0 })

    report({ progressId: id, ...counts })

    expect(result.current.progress).toMatchObject({ signed: 1, total: 4 })
  })

  it('names the transaction of a batch on every count', () => {
    const { result } = renderHook(() => useSigningProgress())
    let id = ''
    act(() => {
      id = result.current.start({ index: 1, count: 3 })
    })
    expect(result.current.progress).toEqual({ transactionIndex: 1, transactionCount: 3 })

    report({ progressId: id, signed: 0, total: 106, cached: 0 })

    expect(result.current.progress).toMatchObject({
      signed: 0,
      total: 106,
      transactionIndex: 1,
      transactionCount: 3,
    })
  })

  it('gives every signing a fresh id, and stopping an earlier one leaves the current one', () => {
    const { result } = renderHook(() => useSigningProgress())
    let first = ''
    let second = ''
    act(() => {
      first = result.current.start()
    })
    act(() => {
      second = result.current.start()
    })
    expect(second).not.toBe(first)

    act(() => {
      result.current.stop(first)
    })
    report({ progressId: first, signed: 2, total: 2, cached: 0 })
    report({ progressId: second, signed: 1, total: 2, cached: 0 })
    expect(result.current.progress).toMatchObject({ signed: 1, total: 2 })

    act(() => {
      result.current.stop(second)
    })
    expect(result.current.progress).toBeNull()
    report({ progressId: second, signed: 2, total: 2, cached: 0 })
    expect(result.current.progress).toBeNull()
  })

  it('stops listening once unmounted', () => {
    const listenersBefore = uiEventBus.events[BUS_METHODS.QBIT_SIGNING_PROGRESS]?.length ?? 0
    const { unmount } = renderHook(() => useSigningProgress())
    expect(uiEventBus.events[BUS_METHODS.QBIT_SIGNING_PROGRESS]).toHaveLength(listenersBefore + 1)

    unmount()

    expect(uiEventBus.events[BUS_METHODS.QBIT_SIGNING_PROGRESS]).toHaveLength(listenersBefore)
  })
})

describe('estimateSigningRemainingMs', () => {
  const sample = (signed: number, at: number, cached = 0) => ({ signed, cached, at })

  it('is unknown until three new signatures have been timed', () => {
    expect(estimateSigningRemainingMs([], 10)).toBeUndefined()
    expect(estimateSigningRemainingMs([sample(0, 0), sample(2, 2_000)], 10)).toBeUndefined()
    expect(estimateSigningRemainingMs([sample(0, 0), sample(3, 3_000)], 10)).toBe(7_000)
  })

  it('uses the rate between the oldest and newest samples', () => {
    // Each of the last four inputs took 2 s.
    expect(estimateSigningRemainingMs([sample(16, 1_000), sample(20, 9_000)], 106)).toBe(172_000)
  })

  it('leaves cached signatures out of the rate', () => {
    // A retry: the first ten inputs come from the cache, then each new
    // signature takes about 0.9 s.
    const cached = Array.from({ length: 10 }, (_, signed) => sample(signed, signed * 5, signed))
    const twoNew = [...cached, sample(10, 900, 9), sample(11, 1_800, 9)]
    expect(estimateSigningRemainingMs(twoNew, 106)).toBeUndefined()

    const threeNew = [...twoNew, sample(12, 2_700, 9)]
    // 2,700 ms for the 3 new signatures since the first sample, for the 94 left.
    expect(estimateSigningRemainingMs(threeNew, 106)).toBe(84_600)
  })

  it('does not drop new signatures whose counts arrive together', () => {
    // Three counts delivered at once after a busy moment still count.
    const samples = [
      sample(10, 0),
      sample(11, 900),
      sample(12, 2_700),
      sample(13, 2_701),
      sample(14, 2_702),
    ]
    expect(estimateSigningRemainingMs(samples, 24)).toBeCloseTo((2_702 / 4) * 10)
  })

  it('is unknown once every input is signed, or when no time has passed', () => {
    expect(estimateSigningRemainingMs([sample(0, 0), sample(5, 5_000)], 5)).toBeUndefined()
    expect(estimateSigningRemainingMs([sample(0, 1_000), sample(4, 1_000)], 10)).toBeUndefined()
  })
})
