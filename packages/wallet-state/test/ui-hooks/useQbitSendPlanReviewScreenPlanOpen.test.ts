import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  QbitSendPlanReview,
  QbitSendPlanStartResult,
  QbitSendPlanView,
} from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { I18nContext } from '../../src/context/I18nContext'
import {
  useQbitSendPlanReviewScreenLogic,
  type QbitSendPlanReviewReady,
  type QbitSendPlanReviewScreenLogic,
} from '../../src/ui-hooks/useQbitSendPlanReviewScreenLogic'
import { deferred, planReview, planView, unreadablePlanView } from './sendPlanFixtures'
import { createHookTestHarness, createNavigationMock } from './testHelpers'

// The background answers Confirm (`startQbitSendPlan`) `plan_open` when the
// account has a plan in progress, or a stored entry it cannot read, and
// keeps the review's draft (#206). That plan can end before the screen
// knows of it, and nothing tells the review screen: it reads the plan once.

/** The review screen on `routeState`, the object its route state reads: a test may change it. */
function renderReview(routeState: { review: QbitSendPlanReview } = { review: planReview() }) {
  const harness = createHookTestHarness({ navigation: createNavigationMock(routeState) })
  const t = vi.fn(
    (key: string, substitutions?: string | string[] | Record<string, string | number>) =>
      substitutions === undefined
        ? key
        : `${key}:${(Array.isArray(substitutions) ? substitutions : [substitutions]).join(',')}`
  )
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      I18nContext.Provider,
      {
        value: {
          t,
          locale: 'en',
          supportedLocales: [],
          localeNames: {},
          changeLocale: async () => {},
          isSpecialLocale: false,
        },
      },
      createElement(harness.wrapper, { children })
    )
  // Every render of the screen, counted: a state update shows as one.
  let renders = 0
  const rendered = renderHook(
    () => {
      renders += 1
      return useQbitSendPlanReviewScreenLogic()
    },
    { wrapper }
  )
  return { ...harness, ...rendered, renders: () => renders }
}

function ready(logic: QbitSendPlanReviewScreenLogic): QbitSendPlanReviewReady {
  if (!logic.ready) throw new Error('no review shown')
  return logic
}

const PLAN_OPEN: QbitSendPlanStartResult = { ok: false, reason: 'plan_open' }
const DRAFT_EXPIRED: QbitSendPlanStartResult = { ok: false, reason: 'draft_expired' }
const started = (): QbitSendPlanStartResult => ({ ok: true, plan: planView() })

/** Another plan of the review's account, in progress: not the one this review would start. */
const otherPlan = (overrides: Partial<QbitSendPlanView> = {}): QbitSendPlanView =>
  planView({ id: 'plan-0', paymentTxid: 'cc'.repeat(32), ...overrides })

/** A review carrying the restored-floor warning, with its challenge. */
function riskyReview(): QbitSendPlanReview {
  return planReview({
    signatureBudget: {
      ...planReview().signatureBudget,
      restoredFloorRisk: {
        recoveryStatus: 'seed-only-restored',
        counterConfidence: 'chain-floor-only',
        knownOnChainSignatures: 0,
        challengeId: 'challenge-1',
      },
    },
  })
}

/** The review as it is offered again: nothing in the way of Confirm. */
function expectConfirmOffered(screen: ReturnType<typeof renderReview>) {
  expect(ready(screen.result.current)).toMatchObject({
    planOpenText: '',
    error: '',
    confirming: false,
    canConfirm: true,
  })
  expect(screen.navigation.replace).not.toHaveBeenCalled()
  expect(screen.navigation.goBack).not.toHaveBeenCalled()
  expect(screen.tools.toastError).not.toHaveBeenCalled()
  expect(screen.tools.showLoading).toHaveBeenLastCalledWith(false)
}

describe('the send plan review answered plan_open (#206)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each<[string, () => QbitSendPlanView | null]>([
    // The plan in progress was cancelled before the screen read it.
    ['finds no plan', () => null],
    ['finds the plan completed', () => otherPlan({ phase: 'completed', actions: ['dismiss'] })],
    // The background shows another account by now: not this review's.
    ['finds a plan of another account', () => otherPlan({ address: 'qb1zotheraccount' })],
    ['finds a plan on another network', () => otherPlan({ chain: ChainType.QBIT_TESTNET4 })],
  ])(
    'offers Confirm again on the same review once the plan read after plan_open %s',
    async (_label, found) => {
      const screen = renderReview()
      const { result, wallet, navigation } = screen
      wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
      wallet.getQbitSendPlan.mockResolvedValueOnce(found())

      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
      expectConfirmOffered(screen)

      // The draft the review holds starts.
      wallet.startQbitSendPlan.mockResolvedValueOnce(started())
      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(2)
      expect(wallet.startQbitSendPlan).toHaveBeenLastCalledWith('draft-1')
      expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
    }
  )

  it('offers Confirm again when the plan read after plan_open fails', async () => {
    const screen = renderReview()
    const { result, wallet } = screen
    wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
    wallet.getQbitSendPlan.mockRejectedValueOnce({ message: 'port closed' })

    await act(async () => ready(result.current).onClickConfirm())
    // Nothing is known of the plan either way; the background answers the start afresh.
    expectConfirmOffered(screen)

    wallet.startQbitSendPlan.mockResolvedValueOnce(started())
    await act(async () => ready(result.current).onClickConfirm())
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(2)
    expect(screen.navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
  })

  it.each<[string, () => QbitSendPlanView]>([
    ['a plan in progress', () => otherPlan()],
    ['a paused plan', () => otherPlan({ phase: 'paused', pause: { reason: 'merge_refused' } })],
    ['a stored plan it cannot read', () => unreadablePlanView('stored-1')],
  ])(
    'keeps the text, its link and Confirm locked when the plan read after plan_open finds %s',
    async (_label, found) => {
      const { result, wallet, navigation } = renderReview()
      wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
      wallet.getQbitSendPlan.mockResolvedValueOnce(found())

      await act(async () => ready(result.current).onClickConfirm())
      expect(ready(result.current)).toMatchObject({
        planOpenText: 'send_plan_already_open',
        error: '',
        confirming: false,
        canConfirm: false,
      })
      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
      act(() => ready(result.current).onClickViewPlan())
      expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
    }
  )

  it('reads the plan once, with Confirm and Reject held while it reads, and sets no timer', async () => {
    vi.useFakeTimers()
    const screen = renderReview()
    const { result, wallet, navigation } = screen
    const timers = vi.getTimerCount()
    const read = deferred<QbitSendPlanView | null>()
    wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
    wallet.getQbitSendPlan.mockReturnValueOnce(read.promise)

    let confirming: Promise<void> | undefined
    await act(async () => {
      confirming = ready(result.current).onClickConfirm()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(ready(result.current)).toMatchObject({ confirming: true, canConfirm: false })
    // A second tap, or Reject, while the plan is read does nothing.
    await act(async () => ready(result.current).onClickConfirm())
    act(() => ready(result.current).onClickReject())
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(navigation.goBack).not.toHaveBeenCalled()

    await act(async () => {
      read.resolve(null)
      await confirming
    })
    expectConfirmOffered(screen)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(timers)
  })

  it('changes nothing once the screen is gone when the plan read lands', async () => {
    const screen = renderReview()
    const { result, wallet, navigation, tools, unmount } = screen
    const read = deferred<QbitSendPlanView | null>()
    wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
    wallet.getQbitSendPlan.mockReturnValueOnce(read.promise)

    let confirming: Promise<void> | undefined
    await act(async () => {
      confirming = ready(result.current).onClickConfirm()
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
    unmount()
    const renders = screen.renders()
    await act(async () => {
      read.resolve(otherPlan())
      await confirming
    })

    expect(screen.renders()).toBe(renders)
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(tools.toastError).not.toHaveBeenCalled()
    expect(tools.showLoading).toHaveBeenLastCalledWith(false)
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  describe('a second Confirm of the same review', () => {
    it('goes back as expired, not with an error, when its draft went meanwhile', async () => {
      const screen = renderReview()
      const { result, wallet, navigation, tools } = screen
      wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
      wallet.getQbitSendPlan.mockResolvedValueOnce(null)
      await act(async () => ready(result.current).onClickConfirm())
      expectConfirmOffered(screen)

      // A lock, or another page's review, let go of the draft.
      wallet.startQbitSendPlan.mockResolvedValueOnce(DRAFT_EXPIRED)
      await act(async () => ready(result.current).onClickConfirm())
      expect(tools.toastError).toHaveBeenCalledWith('send_plan_review_expired')
      expect(navigation.goBack).toHaveBeenCalledTimes(1)
      expect(ready(result.current).error).toBe('')
      expect(navigation.replace).not.toHaveBeenCalled()
    })

    it('asks for the restored-floor acknowledgement once, and confirms it with the background once', async () => {
      const screen = renderReview({ review: riskyReview() })
      const { result, wallet, navigation } = screen
      const order: string[] = []
      wallet.confirmQbitRestoredFloorSigning.mockImplementation(async (challengeId: string) => {
        order.push(`confirm ${challengeId}`)
      })
      wallet.startQbitSendPlan.mockImplementation(async (draftId: string) => {
        order.push(`start ${draftId}`)
        return order.length === 2 ? PLAN_OPEN : started()
      })
      wallet.getQbitSendPlan.mockResolvedValueOnce(null)

      act(() => ready(result.current).onRiskAcceptedChange(true))
      await act(async () => ready(result.current).onClickConfirm())
      expectConfirmOffered(screen)
      // Still acknowledged: nothing to tick again.
      expect(ready(result.current).riskAccepted).toBe(true)

      await act(async () => ready(result.current).onClickConfirm())
      // The background keeps the confirmation until a signature uses it, or
      // the draft goes with its challenge: it is not confirmed again.
      expect(order).toEqual(['confirm challenge-1', 'start draft-1', 'start draft-1'])
      expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
      expect(ready(result.current).error).toBe('')
    })

    it('with the restored-floor warning, goes back as expired when the draft went with its challenge', async () => {
      const screen = renderReview({ review: riskyReview() })
      const { result, wallet, navigation, tools } = screen
      // As the background answers: once the draft goes, its challenge goes
      // with it, and confirming that challenge again is refused as expired.
      wallet.confirmQbitRestoredFloorSigning
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue({ message: 'confirmation expired' })
      wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN).mockResolvedValue(DRAFT_EXPIRED)
      wallet.getQbitSendPlan.mockResolvedValueOnce(null)

      act(() => ready(result.current).onRiskAcceptedChange(true))
      await act(async () => ready(result.current).onClickConfirm())
      expectConfirmOffered(screen)

      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(2)
      expect(tools.toastError).toHaveBeenCalledWith('send_plan_review_expired')
      expect(navigation.goBack).toHaveBeenCalledTimes(1)
      expect(ready(result.current).error).toBe('')
    })

    it('asks the background again for a confirmation it refused', async () => {
      const screen = renderReview({ review: riskyReview() })
      const { result, wallet, navigation } = screen
      wallet.confirmQbitRestoredFloorSigning
        .mockRejectedValueOnce({ message: 'confirmation unavailable' })
        .mockResolvedValue(undefined)
      wallet.startQbitSendPlan.mockResolvedValue(started())

      act(() => ready(result.current).onRiskAcceptedChange(true))
      await act(async () => ready(result.current).onClickConfirm())
      expect(ready(result.current)).toMatchObject({
        error: 'confirmation unavailable',
        canConfirm: true,
      })
      expect(wallet.startQbitSendPlan).not.toHaveBeenCalled()

      // Not confirmed: the next Confirm asks again before it starts.
      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.confirmQbitRestoredFloorSigning.mock.calls).toEqual([
        ['challenge-1'],
        ['challenge-1'],
      ])
      expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
      expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
    })

    it('confirms with the background a challenge the review shows anew', async () => {
      const routeState = { review: riskyReview() }
      const screen = renderReview(routeState)
      const { result, wallet, rerender } = screen
      wallet.startQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
      wallet.getQbitSendPlan.mockResolvedValueOnce(null)
      act(() => ready(result.current).onRiskAcceptedChange(true))
      await act(async () => ready(result.current).onClickConfirm())
      expectConfirmOffered(screen)

      // The review now carries another challenge: acknowledged and confirmed afresh.
      const signatureBudget = riskyReview().signatureBudget
      routeState.review = planReview({
        signatureBudget: {
          ...signatureBudget,
          restoredFloorRisk: { ...signatureBudget.restoredFloorRisk!, challengeId: 'challenge-2' },
        },
      })
      rerender()
      expect(ready(result.current).riskAccepted).toBe(false)
      act(() => ready(result.current).onRiskAcceptedChange(true))
      wallet.startQbitSendPlan.mockResolvedValueOnce(started())
      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.confirmQbitRestoredFloorSigning.mock.calls).toEqual([
        ['challenge-1'],
        ['challenge-2'],
      ])
      expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(2)
      expect(screen.navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
    })
  })
})
