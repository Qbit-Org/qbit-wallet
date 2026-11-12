import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { QbitSendPlanReview, QbitSendPlanStartResult } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { I18nContext } from '../../src/context/I18nContext'
import { settingsActions } from '../../src/reducers/settings'
import {
  useQbitSendPlanReviewScreenLogic,
  type QbitSendPlanReviewReady,
  type QbitSendPlanReviewScreenLogic,
} from '../../src/ui-hooks/useQbitSendPlanReviewScreenLogic'
import { PLAN_RECIPIENT, deferred, planReview, planView } from './sendPlanFixtures'
import { createHookTestHarness, createNavigationMock } from './testHelpers'

function renderReview(review: unknown, harness?: ReturnType<typeof createHookTestHarness>) {
  const testHarness =
    harness ?? createHookTestHarness({ navigation: createNavigationMock({ review }) })
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
      createElement(testHarness.wrapper, { children })
    )
  const rendered = renderHook(() => useQbitSendPlanReviewScreenLogic(), { wrapper })
  return { ...testHarness, ...rendered }
}

function ready(logic: QbitSendPlanReviewScreenLogic): QbitSendPlanReviewReady {
  if (!logic.ready) throw new Error('no review shown')
  return logic
}

const started = (): QbitSendPlanStartResult => ({ ok: true, plan: planView() })

describe('useQbitSendPlanReviewScreenLogic', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the recipient, exactly what they receive, every fee and the signatures', () => {
    const { result } = renderReview(planReview({ change: 5_000 }))
    const logic = ready(result.current)

    expect(logic).toMatchObject({
      title: 'send_plan_review_title',
      recipient: PLAN_RECIPIENT,
      receives: '0.01000000 QBT',
      transactions: 'send_plan_steps_one',
      totalFee: '0.00588827 QBT',
      change: '0.00005000 QBT',
      signing: 'send_plan_signatures:156 · send_plan_time_minutes:3',
      budget: 'send_plan_review_budget:1,073,741,824,1,073,741,668',
      note: 'send_plan_review_note',
      revision: undefined,
      restoredFloorRisk: undefined,
      canConfirm: true,
    })
  })

  it('names the transactions that combine the funds', () => {
    const { result } = renderReview(
      planReview({
        merges: [
          { inputCount: 106, fee: 398_827 },
          { inputCount: 106, fee: 398_827 },
          { inputCount: 40, fee: 150_000 },
        ],
        change: 0,
      })
    )
    expect(ready(result.current)).toMatchObject({
      transactions: 'send_plan_steps_many:3',
      change: '',
    })
  })

  it('confirms once: starts the draft and replaces itself with the progress screen', async () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    const answer = deferred<QbitSendPlanStartResult>()
    harness.wallet.startQbitSendPlan.mockReturnValue(answer.promise)
    const { result, wallet, navigation, tools } = renderReview(undefined, harness)

    let first: Promise<void> | undefined
    act(() => {
      first = ready(result.current).onClickConfirm()
      void ready(result.current).onClickConfirm()
    })
    expect(ready(result.current).confirming).toBe(true)
    expect(ready(result.current).canConfirm).toBe(false)

    await act(async () => {
      answer.resolve(started())
      await first
    })
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.startQbitSendPlan).toHaveBeenCalledWith('draft-1')
    expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
    expect(navigation.navigate).not.toHaveBeenCalled()
    expect(wallet.confirmQbitRestoredFloorSigning).not.toHaveBeenCalled()
    expect(tools.showLoading).toHaveBeenLastCalledWith(false)

    // Started: Confirm stays locked until the screen is gone.
    await act(async () => ready(result.current).onClickConfirm())
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['draft_expired', 'send_plan_review_expired'],
    ['outputs_changed', 'send_plan_outputs_changed'],
  ] as const)(
    'says so and goes back to prepare again when the start is refused as %s',
    async (reason, text) => {
      const harness = createHookTestHarness({
        navigation: createNavigationMock({ review: planReview() }),
      })
      harness.wallet.startQbitSendPlan.mockResolvedValue({ ok: false, reason })
      const { result, navigation, tools } = renderReview(undefined, harness)

      await act(async () => ready(result.current).onClickConfirm())
      expect(tools.toastError).toHaveBeenCalledWith(text)
      expect(navigation.goBack).toHaveBeenCalledTimes(1)
      expect(navigation.replace).not.toHaveBeenCalled()
    }
  )

  it('sends a locked wallet to the unlock screen', async () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    harness.wallet.startQbitSendPlan.mockResolvedValue({ ok: false, reason: 'locked' })
    const { result, navigation } = renderReview(undefined, harness)

    await act(async () => ready(result.current).onClickConfirm())
    expect(navigation.navToLock).toHaveBeenCalledWith({ autoUnlockByFace: false })
    expect(ready(result.current).canConfirm).toBe(true)
  })

  it('links to the payment already in progress', async () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    harness.wallet.startQbitSendPlan.mockResolvedValue({ ok: false, reason: 'plan_open' })
    const { result, navigation, wallet } = renderReview(undefined, harness)

    await act(async () => ready(result.current).onClickConfirm())
    expect(ready(result.current)).toMatchObject({
      planOpenText: 'send_plan_already_open',
      canConfirm: false,
    })
    act(() => ready(result.current).onClickViewPlan())
    expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it('confirms the restored-floor warning with the background before the plan starts', async () => {
    const review = planReview({
      signatureBudget: {
        ...planReview().signatureBudget,
        restoredFloorRisk: {
          recoveryStatus: 'seed-only-restored',
          counterConfidence: 'chain-floor-only',
          knownOnChainSignatures: 7,
          challengeId: 'challenge-9',
        },
      },
    })
    const harness = createHookTestHarness({ navigation: createNavigationMock({ review }) })
    const order: string[] = []
    harness.wallet.confirmQbitRestoredFloorSigning.mockImplementation(async () => {
      order.push('confirm')
    })
    harness.wallet.startQbitSendPlan.mockImplementation(async () => {
      order.push('start')
      return started()
    })
    const { result, wallet } = renderReview(undefined, harness)

    expect(ready(result.current).restoredFloorRisk?.challengeId).toBe('challenge-9')
    expect(ready(result.current).canConfirm).toBe(false)
    // Not without the user's acknowledgement.
    await act(async () => ready(result.current).onClickConfirm())
    expect(wallet.confirmQbitRestoredFloorSigning).not.toHaveBeenCalled()
    expect(wallet.startQbitSendPlan).not.toHaveBeenCalled()

    act(() => ready(result.current).onRiskAcceptedChange(true))
    expect(ready(result.current).canConfirm).toBe(true)
    await act(async () => ready(result.current).onClickConfirm())
    expect(wallet.confirmQbitRestoredFloorSigning).toHaveBeenCalledWith('challenge-9')
    expect(order).toEqual(['confirm', 'start'])
  })

  it('does not start when the restored-floor confirmation fails, and lets the user try again', async () => {
    const review = planReview({
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
    const harness = createHookTestHarness({ navigation: createNavigationMock({ review }) })
    harness.wallet.confirmQbitRestoredFloorSigning.mockRejectedValueOnce({
      message: 'confirmation expired',
    })
    const { result, wallet } = renderReview(undefined, harness)

    act(() => ready(result.current).onRiskAcceptedChange(true))
    await act(async () => ready(result.current).onClickConfirm())
    expect(wallet.startQbitSendPlan).not.toHaveBeenCalled()
    expect(ready(result.current).error).toBe('confirmation expired')
    expect(ready(result.current).canConfirm).toBe(true)
  })

  it("shows the background's message when the start needs a restored-floor confirmation", async () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    // A coded error, not a result: the account's key carries the restored-floor risk.
    harness.wallet.startQbitSendPlan.mockRejectedValueOnce({
      message: 'Restored-floor signing requires explicit confirmation',
      code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED',
    })
    const { result, navigation, tools } = renderReview(undefined, harness)

    await act(async () => ready(result.current).onClickConfirm())
    expect(ready(result.current)).toMatchObject({
      error: 'Restored-floor signing requires explicit confirmation',
      confirming: false,
      canConfirm: true,
    })
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(navigation.goBack).not.toHaveBeenCalled()
    expect(tools.showLoading).toHaveBeenLastCalledWith(false)
  })

  it('goes to the plan when a start that failed without an answer did start it', async () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    harness.wallet.startQbitSendPlan.mockRejectedValue({
      message: 'Attempting to use a disconnected port object',
    })
    harness.wallet.getQbitSendPlan.mockResolvedValue(planView())
    const { result, navigation } = renderReview(undefined, harness)

    await act(async () => ready(result.current).onClickConfirm())
    expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
    expect(ready(result.current).error).toBe('')
  })

  it('offers Confirm again after a start that failed and started nothing', async () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    harness.wallet.startQbitSendPlan.mockRejectedValueOnce({
      message: 'Attempting to use a disconnected port object',
    })
    harness.wallet.getQbitSendPlan.mockResolvedValue(null)
    const { result, navigation, wallet } = renderReview(undefined, harness)

    await act(async () => ready(result.current).onClickConfirm())
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(ready(result.current)).toMatchObject({
      error: 'Attempting to use a disconnected port object',
      canConfirm: true,
    })

    wallet.startQbitSendPlan.mockResolvedValueOnce(started())
    await act(async () => ready(result.current).onClickConfirm())
    expect(wallet.startQbitSendPlan).toHaveBeenCalledTimes(2)
    expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
  })

  describe('a start that failed', () => {
    const risky = (overrides: Partial<QbitSendPlanReview> = {}) =>
      planReview({
        signatureBudget: {
          ...planReview().signatureBudget,
          restoredFloorRisk: {
            recoveryStatus: 'seed-only-restored',
            counterConfidence: 'chain-floor-only',
            knownOnChainSignatures: 0,
            challengeId: 'challenge-1',
          },
        },
        ...overrides,
      })
    // An earlier plan of the account, sent and not dismissed yet: a new
    // plan can be prepared beside it.
    const earlierCompleted = planView({
      id: 'plan-0',
      phase: 'completed',
      actions: ['dismiss'],
      paymentTxid: 'cc'.repeat(32),
    })
    const restoredFloorRefusal = {
      message: 'Restored-floor signing requires explicit confirmation',
      code: 'QBIT_RESTORED_FLOOR_CONFIRMATION_REQUIRED',
    }

    function renderFailing(
      routeState: Record<string, unknown>,
      setUp: (harness: ReturnType<typeof createHookTestHarness>) => void
    ) {
      const harness = createHookTestHarness({ navigation: createNavigationMock(routeState) })
      setUp(harness)
      return renderReview(undefined, harness)
    }

    it('starts nothing and opens nothing when the restored-floor confirmation fails', async () => {
      const { result, wallet, navigation } = renderFailing({ review: risky() }, harness => {
        harness.wallet.confirmQbitRestoredFloorSigning.mockRejectedValueOnce({
          message: 'confirmation expired',
        })
        harness.wallet.getQbitSendPlan.mockResolvedValue(earlierCompleted)
      })
      act(() => ready(result.current).onRiskAcceptedChange(true))
      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.startQbitSendPlan).not.toHaveBeenCalled()
      expect(navigation.replace).not.toHaveBeenCalled()
      expect(ready(result.current)).toMatchObject({
        error: 'confirmation expired',
        canConfirm: true,
      })
    })

    it('does not take an earlier completed plan for the one it started', async () => {
      const { result, navigation } = renderFailing({ review: planReview() }, harness => {
        harness.wallet.startQbitSendPlan.mockRejectedValueOnce(restoredFloorRefusal)
        harness.wallet.getQbitSendPlan.mockResolvedValue(earlierCompleted)
      })
      await act(async () => ready(result.current).onClickConfirm())
      expect(navigation.replace).not.toHaveBeenCalled()
      expect(ready(result.current)).toMatchObject({
        error: 'Restored-floor signing requires explicit confirmation',
        canConfirm: true,
      })
    })

    it('goes to the new plan when the lost answer hid a start that went through', async () => {
      const { result, navigation } = renderFailing({ review: planReview() }, harness => {
        harness.wallet.startQbitSendPlan.mockRejectedValueOnce({
          message: 'Attempting to use a disconnected port object',
        })
        // The plan this review started pays with the review's payment.
        harness.wallet.getQbitSendPlan.mockResolvedValue(
          planView({ id: 'plan-2', paymentTxid: planReview().payment.txid })
        )
      })
      await act(async () => ready(result.current).onClickConfirm())
      expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
      expect(ready(result.current).error).toBe('')
    })

    describe('of a revision', () => {
      // The plan as the progress screen showed it when the revision was asked for.
      const revised = { paymentTxid: 'bb'.repeat(32), feeRate: 1, totalFee: 588_827 }
      const before = planView({
        phase: 'paused',
        pause: { reason: 'payment_fee_too_low' },
        actions: ['raise_payment_fee', 'continue', 'cancel'],
        paymentTxid: revised.paymentTxid,
        feeRate: revised.feeRate,
      })
      const raise = planReview({
        revises: { planId: 'plan-1', kind: 'raise_payment_fee' },
        feeRate: 2,
        payment: { inputCount: 50, fee: 380_000, txid: 'dd'.repeat(32) },
      })

      it('stays on the review when the plan it revises is unchanged', async () => {
        const { result, navigation } = renderFailing({ review: raise, revised }, harness => {
          harness.wallet.startQbitSendPlan.mockRejectedValueOnce(restoredFloorRefusal)
          harness.wallet.getQbitSendPlan.mockResolvedValue(before)
        })
        await act(async () => ready(result.current).onClickConfirm())
        expect(navigation.replace).not.toHaveBeenCalled()
        expect(ready(result.current)).toMatchObject({
          error: 'Restored-floor signing requires explicit confirmation',
          canConfirm: true,
        })
      })

      it('stays on the review when the restored-floor confirmation fails', async () => {
        const { result, wallet, navigation } = renderFailing(
          {
            review: { ...raise, signatureBudget: risky().signatureBudget },
            revised,
          },
          harness => {
            harness.wallet.confirmQbitRestoredFloorSigning.mockRejectedValueOnce({
              message: 'confirmation expired',
            })
            harness.wallet.getQbitSendPlan.mockResolvedValue(before)
          }
        )
        act(() => ready(result.current).onRiskAcceptedChange(true))
        await act(async () => ready(result.current).onClickConfirm())
        expect(wallet.startQbitSendPlan).not.toHaveBeenCalled()
        expect(navigation.replace).not.toHaveBeenCalled()
        expect(ready(result.current).error).toBe('confirmation expired')
      })

      it('goes to the plan once it carries the raise, as after a lost answer', async () => {
        const { result, navigation } = renderFailing({ review: raise, revised }, harness => {
          harness.wallet.startQbitSendPlan.mockRejectedValueOnce({
            message: 'Attempting to use a disconnected port object',
          })
          harness.wallet.getQbitSendPlan.mockResolvedValue(
            planView({ paymentTxid: raise.payment.txid, feeRate: raise.feeRate, revision: 9 })
          )
        })
        await act(async () => ready(result.current).onClickConfirm())
        expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
        expect(ready(result.current).error).toBe('')
      })

      it('goes to the plan once a replan rebuilt its payment', async () => {
        const replan = planReview({
          revises: { planId: 'plan-1', kind: 'replan' },
          feeRate: 1,
          payment: { inputCount: 4, fee: 15_000, txid: 'ee'.repeat(32) },
        })
        const { result, navigation } = renderFailing({ review: replan, revised }, harness => {
          harness.wallet.startQbitSendPlan.mockRejectedValueOnce({
            message: 'Attempting to use a disconnected port object',
          })
          harness.wallet.getQbitSendPlan.mockResolvedValue(
            planView({ paymentTxid: replan.payment.txid, feeRate: 1, revision: 9 })
          )
        })
        await act(async () => ready(result.current).onClickConfirm())
        expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
      })

      it.each<[string, Record<string, unknown>]>([
        ['rebuilt the same payment at the same rate', { revised }],
        ['came without the plan it revised', {}],
        // A rate lost on the port arrives as null.
        ['came with the plan it revised but no rate', { revised: { ...revised, feeRate: null } }],
      ])(
        'cannot tell a replan that %s from one not started, and stays on the review',
        async (_label, extra) => {
          // The same outputs at the same rate make the same payment.
          const replan = planReview({
            revises: { planId: 'plan-1', kind: 'replan' },
            feeRate: revised.feeRate,
            payment: { inputCount: 50, fee: 190_000, txid: revised.paymentTxid },
          })
          const { result, navigation } = renderFailing({ review: replan, ...extra }, harness => {
            harness.wallet.startQbitSendPlan.mockRejectedValueOnce({
              message: 'Attempting to use a disconnected port object',
            })
            harness.wallet.getQbitSendPlan.mockResolvedValue(
              planView({
                phase: 'paused',
                pause: { reason: 'merge_refused' },
                actions: ['replan', 'cancel'],
                paymentTxid: revised.paymentTxid,
                feeRate: revised.feeRate,
              })
            )
          })
          await act(async () => ready(result.current).onClickConfirm())
          expect(navigation.replace).not.toHaveBeenCalled()
          expect(ready(result.current)).toMatchObject({
            error: 'Attempting to use a disconnected port object',
            canConfirm: true,
          })
        }
      )
    })
  })

  it('stops offering Confirm once the review expires', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const { result, wallet } = renderReview(planReview({ expiresAt: now + 30_000 }))
    expect(ready(result.current).canConfirm).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(ready(result.current)).toMatchObject({
      unusableText: 'send_plan_review_expired',
      canConfirm: false,
    })
    await act(async () => ready(result.current).onClickConfirm())
    expect(wallet.startQbitSendPlan).not.toHaveBeenCalled()
  })

  it('refuses a review for another network than the selected one', () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    harness.store.dispatch(
      (settingsActions as any).updateSettings({ chainType: ChainType.QBIT_TESTNET4 })
    )
    const { result } = renderReview(undefined, harness)
    expect(ready(result.current)).toMatchObject({
      unusableText: 'send_plan_review_unavailable',
      canConfirm: false,
    })
  })

  it.each([
    ['no review', undefined],
    ['a review without its draft', { ...planReview(), draftId: '' }],
    ['a review whose amount was lost on the port', { ...planReview(), amount: null }],
    ['a review whose budget is missing', { ...planReview(), signatureBudget: undefined }],
    [
      'a revision of an unknown kind',
      { ...planReview(), revises: { planId: 'plan-1', kind: 'shrink' } },
    ],
  ])('can only be left with %s', (_label, review) => {
    const { result, navigation } = renderReview(review)
    expect(result.current).toMatchObject({
      ready: false,
      unavailableText: 'send_plan_review_unavailable',
    })
    act(() => result.current.onClickReject())
    expect(navigation.goBack).toHaveBeenCalledTimes(1)
  })

  it('rejects by going back, and not while the plan is being started', async () => {
    const harness = createHookTestHarness({
      navigation: createNavigationMock({ review: planReview() }),
    })
    const answer = deferred<QbitSendPlanStartResult>()
    harness.wallet.startQbitSendPlan.mockReturnValue(answer.promise)
    const { result, navigation } = renderReview(undefined, harness)

    let confirming: Promise<void> | undefined
    act(() => {
      confirming = ready(result.current).onClickConfirm()
    })
    act(() => ready(result.current).onClickReject())
    expect(navigation.goBack).not.toHaveBeenCalled()
    await act(async () => {
      answer.resolve({ ok: false, reason: 'plan_open' })
      await confirming
    })
    act(() => ready(result.current).onClickReject())
    expect(navigation.goBack).toHaveBeenCalledTimes(1)
  })

  describe('a revision', () => {
    function revision(overrides: Partial<QbitSendPlanReview>) {
      return planReview({ revises: { planId: 'plan-1', kind: 'raise_payment_fee' }, ...overrides })
    }

    it('keeps the recipient and the amount, and shows the fees already paid', () => {
      const { result } = renderReview(
        revision({ previousAmount: 1_000_000, paidFee: 398_827, totalFee: 610_000, merges: [] })
      )
      expect(ready(result.current)).toMatchObject({
        revision: {
          title: 'send_plan_revision_title',
          lines: ['send_plan_revision_unchanged', 'send_plan_revision_paid:0.00398827,QBT'],
        },
        totalFee: '0.00610000 QBT',
        transactions: 'send_plan_steps_none',
      })
    })

    it('states both amounts when the user is choosing a new one', () => {
      const { result } = renderReview(
        revision({ target: 'everything', amount: 980_000, previousAmount: 1_000_000, paidFee: 0 })
      )
      expect(ready(result.current).revision?.lines).toEqual([
        'send_plan_revision_recipient_unchanged',
        'send_plan_revision_amount:0.00980000,QBT,0.01000000,QBT',
      ])
    })

    it('says only that the recipient stays for the whole balance without an amount before', () => {
      const { result } = renderReview(revision({ target: 'everything', paidFee: 0 }))
      expect(ready(result.current).revision?.lines).toEqual([
        'send_plan_revision_recipient_unchanged',
      ])
    })

    describe('says what actually changes', () => {
      // The plan as the progress screen showed it when the revision was asked for.
      const revised = { paymentTxid: 'bb'.repeat(32), feeRate: 1, totalFee: 588_827 }
      function renderWith(review: QbitSendPlanReview) {
        return renderReview(
          undefined,
          createHookTestHarness({ navigation: createNavigationMock({ review, revised }) })
        )
      }

      it('calls a replan that changes nothing a new plan for the same payment', () => {
        const { result } = renderWith(
          planReview({
            revises: { planId: 'plan-1', kind: 'replan' },
            previousAmount: undefined,
            totalFee: revised.totalFee,
          })
        )
        expect(ready(result.current).revision).toEqual({
          title: 'send_plan_revision_same_title',
          lines: ['send_plan_revision_same'],
        })
      })

      it('names the new total fee beside the one it replaces', () => {
        const { result } = renderWith(revision({ feeRate: 2, totalFee: 778_827, paidFee: 0 }))
        expect(ready(result.current).revision).toEqual({
          title: 'send_plan_revision_title',
          lines: [
            'send_plan_revision_unchanged',
            'send_plan_revision_total_fee:0.00778827,QBT,0.00588827,QBT',
          ],
        })
      })

      it('names the new amount and the new total fee of the whole balance', () => {
        const { result } = renderWith(
          revision({
            target: 'everything',
            amount: 980_000,
            previousAmount: 1_000_000,
            feeRate: 2,
            totalFee: 608_827,
            paidFee: 398_827,
          })
        )
        expect(ready(result.current).revision?.lines).toEqual([
          'send_plan_revision_recipient_unchanged',
          'send_plan_revision_amount:0.00980000,QBT,0.01000000,QBT',
          'send_plan_revision_total_fee:0.00608827,QBT,0.00588827,QBT',
          'send_plan_revision_paid:0.00398827,QBT',
        ])
      })

      it('keeps the fees already paid on a plan that changes nothing else', () => {
        const { result } = renderWith(
          planReview({
            revises: { planId: 'plan-1', kind: 'replan' },
            totalFee: revised.totalFee,
            paidFee: 398_827,
          })
        )
        expect(ready(result.current).revision).toEqual({
          title: 'send_plan_revision_same_title',
          lines: ['send_plan_revision_same', 'send_plan_revision_paid:0.00398827,QBT'],
        })
      })
    })

    it('starts the revised draft like a new plan', async () => {
      const harness = createHookTestHarness({
        navigation: createNavigationMock({ review: revision({ draftId: 'draft-7' }) }),
      })
      harness.wallet.startQbitSendPlan.mockResolvedValue(started())
      const { result, wallet, navigation } = renderReview(undefined, harness)
      await act(async () => ready(result.current).onClickConfirm())
      expect(wallet.startQbitSendPlan).toHaveBeenCalledWith('draft-7')
      await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen'))
    })
  })
})
