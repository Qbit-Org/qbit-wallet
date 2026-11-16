import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { type QbitSendPlanAction, type QbitSendPlanView } from '@qbit/wallet-shared'

import { I18nContext } from '../../src/context/I18nContext'
import { uiActions } from '../../src/reducers/ui'
import {
  useQbitSendPlanScreenLogic,
  type QbitSendPlanScreenLogic,
  type QbitSendPlanScreenReady,
} from '../../src/ui-hooks/useQbitSendPlanScreenLogic'
import { useQbitSendPlanEntryLogic } from '../../src/ui-hooks/useQbitSendPlanEntryLogic'
import { readQbitSendPlanView } from '../../src/utils/qbit-send-plan'
import { planView } from './sendPlanFixtures'
import { createHookTestHarness } from './testHelpers'

// A payment refused for its fee whose funds cannot pay a higher one, or
// whose fee has been raised as many times as a plan allows (#206): the
// background offers no raise of its fee, and refuses one a page showing an
// earlier view still asks for, with `fee_not_raisable` or
// `fee_raise_limit_reached`. The screen says what is true then, and what the
// user can do: send it again, or cancel.

/** Keys with their substitutions, so a test reads what the copy was built from. */
function recordingI18n(baseWrapper: ({ children }: { children: ReactNode }) => any) {
  const t = vi.fn((key: string, substitutions?: string | string[]) =>
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
      createElement(baseWrapper, { children })
    )
  return { t, wrapper }
}

async function renderScreen(plan: QbitSendPlanView, harness = createHookTestHarness()) {
  harness.wallet.getQbitSendPlan.mockResolvedValue(plan)
  const { wrapper } = recordingI18n(harness.wrapper)
  const rendered = renderHook(() => useQbitSendPlanScreenLogic(), { wrapper })
  await waitFor(() => expect(rendered.result.current.ready).toBe(true))
  return { ...harness, ...rendered }
}

function ready(logic: QbitSendPlanScreenLogic): QbitSendPlanScreenReady {
  if (!logic.ready) throw new Error('the plan is not shown')
  return logic
}

function clickAction(logic: QbitSendPlanScreenLogic, action: QbitSendPlanAction): void {
  const button = ready(logic).buttons.find(entry => entry.action === action)
  if (!button) throw new Error(`no ${action} button`)
  button.onClick()
}

/** A plan whose merge confirmed and whose payment the network refused, as the background shows it. */
function refusedPayment(overrides: Partial<QbitSendPlanView>): QbitSendPlanView {
  return planView({
    phase: 'paused',
    change: 0,
    steps: [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'confirmed' },
      { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 2, fee: 9_577, status: 'signed' },
    ],
    sent: true,
    signing: undefined,
    ...overrides,
  })
}

describe('a payment refused for its fee that no raise can make pay more', () => {
  it('says the funds it uses cannot pay a higher fee, and leads with continue', async () => {
    const { result } = await renderScreen(
      refusedPayment({
        pause: { reason: 'payment_fee_too_low' },
        actions: ['continue', 'cancel'],
      })
    )
    const logic = ready(result.current)
    expect(logic.pause).toEqual({
      title: 'send_plan_paused_payment_fee_too_low',
      body: 'send_plan_paused_payment_fee_too_low_not_raisable_body',
      next: '',
      funds: 'send_plan_funds_combined',
      detail: '',
    })
    expect(logic.buttons.map(button => [button.action, button.primary])).toEqual([
      ['continue', true],
      ['cancel', false],
    ])
  })

  it('still tells the user to raise the fee while the raise is offered', async () => {
    const { result } = await renderScreen(
      refusedPayment({
        pause: { reason: 'payment_fee_too_low' },
        actions: ['raise_payment_fee', 'continue', 'cancel'],
      })
    )
    expect(ready(result.current).pause).toMatchObject({
      title: 'send_plan_paused_payment_fee_too_low',
      body: 'send_plan_paused_payment_fee_too_low_body',
    })
  })

  it('shows a refusal without a reason as a refusal, to review again or cancel, when no raise is offered', async () => {
    const { result } = await renderScreen(
      refusedPayment({
        pause: { reason: 'payment_refused' },
        actions: ['continue', 'replan', 'cancel'],
      })
    )
    const logic = ready(result.current)
    expect(logic.pause).toMatchObject({
      title: 'send_plan_paused_payment_refused',
      body: 'send_plan_paused_payment_refused_body',
    })
    expect(logic.buttons.map(button => [button.action, button.primary])).toEqual([
      ['replan', true],
      ['continue', false],
      ['cancel', false],
    ])
  })

  it('says on the home screen that the payment is paused on its fee', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(
      refusedPayment({ pause: { reason: 'payment_fee_too_low' }, actions: ['continue', 'cancel'] })
    )
    const { wrapper } = recordingI18n(harness.wrapper)
    const { result } = renderHook(() => useQbitSendPlanEntryLogic(), { wrapper })
    await waitFor(() => expect(result.current).toBeTruthy())
    expect(result.current).toMatchObject({
      status: 'send_plan_paused_payment_fee_too_low',
      tone: 'paused',
    })
  })

  it('says why a raise asked for from an earlier view cannot be prepared, and opens no review', async () => {
    const harness = createHookTestHarness()
    // A Custom rate, the user's own, settles at once.
    harness.store.dispatch(
      (uiActions as any).updateFeeRateBar({ feeRate: 1, feeRateInputVal: '1', feeOptionIndex: 3 })
    )
    // The view this page shows still offers the raise.
    const { result, wallet, navigation, store } = await renderScreen(
      refusedPayment({
        pause: { reason: 'payment_fee_too_low' },
        actions: ['raise_payment_fee', 'continue', 'cancel'],
      }),
      harness
    )
    wallet.prepareQbitSendPlan.mockResolvedValue({
      ok: false,
      reason: 'fee_not_raisable',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
    })
    act(() => clickAction(result.current, 'raise_payment_fee'))
    act(() => {
      store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 2, feeRateInputVal: '2' }))
    })
    await waitFor(() => expect(ready(result.current).raiseDialog?.canReview).toBe(true))
    await act(async () => ready(result.current).raiseDialog?.onReview())
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledWith(
      expect.objectContaining({ revise: { planId: 'plan-1', kind: 'raise_payment_fee' } })
    )
    expect(ready(result.current).actionError).toBe('send_plan_fee_not_raisable')
    expect(navigation.navigate).not.toHaveBeenCalled()
  })
})

describe('a payment refused for its fee whose fee has been raised as many times as a plan allows', () => {
  /** The payment's last version, refused for its fee: its change could pay more. */
  function atTheLimit(overrides: Partial<QbitSendPlanView>): QbitSendPlanView {
    return refusedPayment({
      change: 1_500_000,
      pause: { reason: 'payment_fee_too_low' },
      actions: ['continue', 'cancel'],
      paymentFeeRaiseLimitReached: true,
      ...overrides,
    })
  }

  it('says its fee was raised as many times as the wallet allows, not that its funds cannot pay more, and leads with continue', async () => {
    const { result } = await renderScreen(atTheLimit({}))
    const logic = ready(result.current)
    expect(logic.pause).toEqual({
      title: 'send_plan_paused_payment_fee_too_low',
      body: 'send_plan_paused_payment_fee_too_low_raise_limit_body',
      next: '',
      funds: 'send_plan_funds_combined',
      detail: '',
    })
    expect(logic.buttons.map(button => [button.action, button.primary])).toEqual([
      ['continue', true],
      ['cancel', false],
    ])
  })

  it('reads what the background says of the limit only as true', () => {
    expect(readQbitSendPlanView(atTheLimit({}))).toMatchObject({
      paymentFeeRaiseLimitReached: true,
    })
    for (const value of [false, 1, 'true', null, {}]) {
      const read = readQbitSendPlanView({ ...atTheLimit({}), paymentFeeRaiseLimitReached: value })
      expect(read, String(value)).toMatchObject({ id: 'plan-1', actions: ['continue', 'cancel'] })
      expect(read, String(value)).not.toHaveProperty('paymentFeeRaiseLimitReached')
    }
  })

  it('shows a refusal without a reason as a refusal, to review again or cancel', async () => {
    const { result } = await renderScreen(
      atTheLimit({
        pause: { reason: 'payment_refused' },
        actions: ['continue', 'replan', 'cancel'],
      })
    )
    expect(ready(result.current).pause).toMatchObject({
      title: 'send_plan_paused_payment_refused',
      body: 'send_plan_paused_payment_refused_body',
    })
  })

  it('says, while a version of the payment may still go through, that the same payment can be sent again', async () => {
    const { result } = await renderScreen(
      atTheLimit({ paymentMayConfirm: true, actions: ['continue'] })
    )
    expect(ready(result.current).pause).toMatchObject({
      title: 'send_plan_may_confirm_title',
      body: 'send_plan_may_confirm_body',
      next: 'send_plan_may_confirm_continue',
    })
  })

  it('says why a raise asked for from an earlier view cannot be prepared, and opens no review', async () => {
    const harness = createHookTestHarness()
    // A Custom rate, the user's own, settles at once.
    harness.store.dispatch(
      (uiActions as any).updateFeeRateBar({ feeRate: 1, feeRateInputVal: '1', feeOptionIndex: 3 })
    )
    // The view this page shows still offers the raise.
    const { result, wallet, navigation, store } = await renderScreen(
      refusedPayment({
        change: 1_500_000,
        pause: { reason: 'payment_fee_too_low' },
        actions: ['raise_payment_fee', 'continue', 'cancel'],
      }),
      harness
    )
    wallet.prepareQbitSendPlan.mockResolvedValue({
      ok: false,
      reason: 'fee_raise_limit_reached',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
    })
    act(() => clickAction(result.current, 'raise_payment_fee'))
    act(() => {
      store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 2, feeRateInputVal: '2' }))
    })
    await waitFor(() => expect(ready(result.current).raiseDialog?.canReview).toBe(true))
    await act(async () => ready(result.current).raiseDialog?.onReview())
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledWith(
      expect.objectContaining({ revise: { planId: 'plan-1', kind: 'raise_payment_fee' } })
    )
    expect(ready(result.current).actionError).toBe('send_plan_fee_raise_limit_reached')
    expect(navigation.navigate).not.toHaveBeenCalled()
  })
})
