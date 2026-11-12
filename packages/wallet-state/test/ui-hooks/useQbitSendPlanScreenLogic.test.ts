import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  BUS_METHODS,
  type QbitSendPlanAction,
  type QbitSendPlanPauseReason,
  type QbitSendPlanView,
} from '@qbit/wallet-shared'

import { I18nContext } from '../../src/context/I18nContext'
import { uiActions } from '../../src/reducers/ui'
import {
  useQbitSendPlanScreenLogic,
  type QbitSendPlanScreenLogic,
  type QbitSendPlanScreenReady,
} from '../../src/ui-hooks/useQbitSendPlanScreenLogic'
import { useQbitSendPlanEntryLogic } from '../../src/ui-hooks/useQbitSendPlanEntryLogic'
import { uiEventBus } from '../../src/utils/eventBus'
import {
  PLAN_RECIPIENT,
  deferred,
  planReview,
  planView,
  refusedPlanView,
  unreadablePlanView,
} from './sendPlanFixtures'
import { createHookTestHarness } from './testHelpers'

/** Keys with their substitutions, so a test reads what the copy was built from. */
function recordingI18n(baseWrapper: ({ children }: { children: ReactNode }) => any) {
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
      createElement(baseWrapper, { children })
    )
  return { t, wrapper }
}

async function renderScreen(plan: QbitSendPlanView | null, harness = createHookTestHarness()) {
  harness.wallet.getQbitSendPlan.mockResolvedValue(plan)
  const { wrapper } = recordingI18n(harness.wrapper)
  const rendered = renderHook(() => useQbitSendPlanScreenLogic(), { wrapper })
  await waitFor(() => expect(harness.wallet.getQbitSendPlan).toHaveBeenCalled())
  if (plan) await waitFor(() => expect(rendered.result.current.ready).toBe(true))
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

/**
 * Every view the background sends for a plan paused `unreadable`, and the
 * technical detail its pause shows: the stand-in for a stored plan it
 * cannot read, and a stored plan whose check refused a step before its
 * signature, which comes with every figure its record states.
 */
const UNREADABLE_VIEWS: [string, QbitSendPlanView, string][] = [
  ['the stand-in for a stored plan it cannot read', unreadablePlanView('stored-1'), ''],
  [
    'a stored plan whose check refused a merge',
    refusedPlanView('merge'),
    'Qbit send plan transaction does not match its plan: merge output',
  ],
  [
    'a stored plan whose check refused the payment, once the merge went out',
    refusedPlanView('payment'),
    'Qbit send plan transaction does not match its plan: payment change output',
  ],
]

describe('useQbitSendPlanScreenLogic', () => {
  it('shows signing with the signatures done, the transaction and the time left', async () => {
    const { result } = await renderScreen(
      planView({
        signaturesDone: 40,
        signaturesTotal: 156,
        signing: { step: 0, signed: 40, total: 106 },
      })
    )
    const logic = ready(result.current)

    expect(logic.title).toBe('send_plan_header')
    expect(logic.amount).toBe('0.01000000 QBT')
    expect(logic.recipient).toBe(PLAN_RECIPIENT)
    expect(logic.fee).toBe('send_plan_fee_summary:0.00588827,QBT,1')
    expect(logic.signing).toMatchObject({
      count: 'send_plan_signatures_progress:40,156',
      transaction: 'signing_progress_transaction:1,2',
    })
    expect(logic.signing?.percent).toBeCloseTo((40 / 156) * 100)
    // Until the pace is measured, the estimate for what is left: 116
    // signatures and 2 transactions, 151 seconds.
    expect(logic.signing?.timeLeft).toBe('signing_progress_minutes_left:3')
    expect(logic.note).toBe('send_plan_signing_close_note')
    expect(logic.stages.map(stage => [stage.key, stage.state])).toEqual([
      ['signing', 'active'],
      ['combining', 'pending'],
      ['paying', 'pending'],
      ['done', 'pending'],
    ])
    expect(logic.pause).toBeUndefined()
  })

  describe('the time left while signing', () => {
    // A plan of 216 signatures: two merges of 106, then a payment of 4.
    const steps = (statuses: [string, string, string]): QbitSendPlanView['steps'] => [
      {
        kind: 'merge',
        txid: 'a1'.repeat(32),
        inputCount: 106,
        fee: 398_827,
        status: statuses[0] as any,
      },
      {
        kind: 'merge',
        txid: 'a2'.repeat(32),
        inputCount: 106,
        fee: 398_827,
        status: statuses[1] as any,
      },
      {
        kind: 'payment',
        txid: 'bb'.repeat(32),
        inputCount: 4,
        fee: 15_000,
        status: statuses[2] as any,
      },
    ]
    /**
     * The view the background sends with `done` signatures made, as it
     * makes them: its `updatedAt` moves only when the record is written,
     * here when signing started (0) and when the first merge went out.
     */
    const viewAt = (done: number, revision: number): QbitSendPlanView => {
      const step = done < 106 ? 0 : done < 212 ? 1 : 2
      return planView({
        steps: steps(
          done < 106 ? ['planned', 'planned', 'planned'] : ['broadcast', 'planned', 'planned']
        ),
        signaturesDone: done,
        signaturesTotal: 216,
        signing: { step, signed: done - [0, 106, 212][step]!, total: [106, 106, 4][step]! },
        updatedAt: done < 106 ? 0 : 95_000,
        revision,
      })
    }

    /** Minutes the text says are left, 0 for under a minute. */
    const minutesOf = (text: string | undefined): number => {
      if (text === 'signing_progress_under_a_minute') return 0
      const match = /^signing_progress_minutes_left:(\d+)$/.exec(text ?? '')
      if (!match) throw new Error(`no time left in ${text}`)
      return Number(match[1])
    }

    async function signAlong(
      firstSeen: number,
      last: number,
      { msPerSignature = 850, gapMs = 3_000 }: { msPerSignature?: number; gapMs?: number } = {}
    ) {
      let clock = 1_000_000
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      const harness = createHookTestHarness()
      let revision = 2
      const { result, wallet } = await renderScreen(viewAt(firstSeen, revision), harness)
      const shown: string[] = []
      for (let done = firstSeen + 1; done <= last; done++) {
        // Each signature takes its time; a merge going out between two takes longer.
        clock += msPerSignature + (done === 107 ? gapMs : 0)
        revision += 1
        wallet.getQbitSendPlan.mockResolvedValue(viewAt(done, revision))
        await act(async () => {
          uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision })
        })
        await waitFor(() => expect(ready(result.current).plan.revision).toBe(revision))
        shown.push(ready(result.current).signing?.timeLeft ?? '')
      }
      now.mockRestore()
      return shown
    }

    it('gives the estimate for what is left until it has timed enough signatures', async () => {
      const shown = await signAlong(98, 100)
      // 116 signatures and 3 transactions left: 154 seconds.
      expect(shown).toEqual(['signing_progress_minutes_left:3', 'signing_progress_minutes_left:3'])
    })

    it("measures the pace by this page's clock, not by when the plan was last written", async () => {
      // The page opens at 98 of 216 signatures, while the first merge signs.
      const shown = await signAlong(98, 109)
      // Real pace 0.85 s: 107 signatures and 2 transactions left, about 97 seconds.
      expect(shown[shown.length - 1]).toBe('signing_progress_minutes_left:2')
    })

    it('never shows more time left while signing goes on at a steady pace', async () => {
      const shown = await signAlong(98, 215)
      const minutes = shown.map(minutesOf)
      minutes.forEach((value, index) => {
        if (index > 0)
          expect(value, `after ${99 + index} signatures`).toBeLessThanOrEqual(minutes[index - 1]!)
      })
      expect(minutes[minutes.length - 1]).toBe(0)
    })
  })

  it('counts the funds combined while it waits, and says the window can close', async () => {
    const { result } = await renderScreen(
      planView({
        phase: 'waiting',
        signaturesDone: 156,
        steps: [
          {
            kind: 'merge',
            txid: 'a1'.repeat(32),
            inputCount: 106,
            fee: 398_827,
            status: 'confirmed',
          },
          {
            kind: 'merge',
            txid: 'a2'.repeat(32),
            inputCount: 106,
            fee: 398_827,
            status: 'broadcast',
          },
          { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 3, fee: 11_000, status: 'signed' },
        ],
        sent: true,
        signing: undefined,
      })
    )
    const logic = ready(result.current)
    expect(logic.signing).toBeUndefined()
    expect(logic.note).toBe('send_plan_waiting_note')
    expect(logic.stages.map(stage => [stage.key, stage.state, stage.detail])).toEqual([
      ['signing', 'done', 'send_plan_signatures_progress:156,156'],
      ['combining', 'active', 'send_plan_combine_progress:1,2'],
      ['paying', 'pending', undefined],
      ['done', 'pending', undefined],
    ])
  })

  it('says when combining is slow, without offering anything the plan does not', async () => {
    const { result } = await renderScreen(
      planView({ phase: 'waiting', slowMerge: true, actions: ['raise_merge_fee', 'cancel'] })
    )
    const logic = ready(result.current)
    expect(logic.slowMerge).toBe('send_plan_slow_merge')
    expect(logic.buttons.map(button => button.action)).toEqual(['raise_merge_fee', 'cancel'])
    expect(logic.buttons.find(button => button.primary)?.action).toBe('raise_merge_fee')
  })

  // The three terms the user confirmed are in front of them before any
  // action that leads to a signature: Continue after a restart or a lock,
  // and a review again or a raised fee, which sign once reviewed.
  it.each<[string, Partial<QbitSendPlanView>]>([
    [
      'paused interrupted',
      { phase: 'paused', pause: { reason: 'interrupted' }, actions: ['continue', 'cancel'] },
    ],
    [
      'paused locked',
      { phase: 'paused', pause: { reason: 'locked' }, actions: ['continue', 'cancel'] },
    ],
    [
      'paused merge_refused',
      { phase: 'paused', pause: { reason: 'merge_refused' }, actions: ['replan', 'cancel'] },
    ],
    [
      'paused outputs_spent',
      { phase: 'paused', pause: { reason: 'outputs_spent' }, actions: ['replan', 'cancel'] },
    ],
    [
      'paused payment_fee_too_low',
      {
        phase: 'paused',
        pause: { reason: 'payment_fee_too_low' },
        actions: ['raise_payment_fee', 'continue', 'cancel'],
      },
    ],
    [
      'paused payment_refused',
      {
        phase: 'paused',
        pause: { reason: 'payment_refused' },
        actions: ['raise_payment_fee', 'continue', 'replan', 'cancel'],
      },
    ],
    [
      'paused for a reason this version does not know',
      { phase: 'paused', pause: { reason: 'new_reason' as any }, actions: ['continue', 'cancel'] },
    ],
    [
      'waiting, with a slow merge',
      { phase: 'waiting', slowMerge: true, actions: ['raise_merge_fee', 'cancel'] },
    ],
    ['sending', { phase: 'sending', actions: [] }],
    ['cancelling', { phase: 'cancelling', actions: [] }],
  ])(
    'shows the total fee and its rate with the amount and the recipient, %s',
    async (_label, state) => {
      const { result } = await renderScreen(planView({ signing: undefined, ...state }))
      const logic = ready(result.current)
      expect(logic.amount).toBe('0.01000000 QBT')
      expect(logic.recipient).toBe(PLAN_RECIPIENT)
      expect(logic.fee).toBe('send_plan_fee_summary:0.00588827,QBT,1')
    }
  )

  it('shows the total fee as the background states it, and its rate as the wallet shows rates', async () => {
    // The view's total fee counts every fee of the plan, those an earlier
    // version paid included; a rate shows rounded down to hundredths.
    const { result } = await renderScreen(
      planView({
        phase: 'paused',
        pause: { reason: 'interrupted' },
        actions: ['continue', 'cancel'],
        feeRate: 2.519,
        totalFee: 1_234_567,
        signing: undefined,
      })
    )
    expect(ready(result.current).fee).toBe('send_plan_fee_summary:0.01234567,QBT,2.51')
  })

  // Each pause with the actions the background offers for it (`actionsOf`),
  // in the order it sends them, and what its copy tells the user to do.
  it.each<[QbitSendPlanPauseReason, QbitSendPlanAction[], QbitSendPlanAction[]]>([
    ['locked', ['continue', 'cancel'], ['continue', 'cancel']],
    ['interrupted', ['continue', 'cancel'], ['continue', 'cancel']],
    ['merge_refused', ['replan', 'cancel'], ['replan', 'cancel']],
    ['outputs_spent', ['replan', 'cancel'], ['replan', 'cancel']],
    // "Raise the fee to send it."
    [
      'payment_fee_too_low',
      ['raise_payment_fee', 'continue', 'cancel'],
      ['raise_payment_fee', 'continue', 'cancel'],
    ],
    // "Review it again, or cancel it."
    ['payment_refused', ['continue', 'replan', 'cancel'], ['replan', 'continue', 'cancel']],
  ])(
    'leads the %s pause with the action its copy names, as the primary button',
    async (reason, offered, shown) => {
      const { result } = await renderScreen(
        planView({ phase: 'paused', pause: { reason }, actions: offered, signing: undefined })
      )
      const logic = ready(result.current)
      expect(logic.buttons.map(button => button.action)).toEqual(shown)
      expect(logic.buttons.filter(button => button.primary).map(button => button.action)).toEqual([
        shown[0],
      ])
    }
  )

  it('says a fee too low is the usual cause of a refusal without a reason, and leads with the raise', async () => {
    // The explorer relays a node refusal as an RPC code only, so the
    // background cannot tell a fee refusal apart and offers the raise.
    const { result } = await renderScreen(
      planView({
        phase: 'paused',
        pause: { reason: 'payment_refused' },
        actions: ['raise_payment_fee', 'continue', 'replan', 'cancel'],
        signing: undefined,
      })
    )
    const logic = ready(result.current)
    expect(logic.pause).toMatchObject({
      title: 'send_plan_paused_payment_refused_unexplained',
      body: 'send_plan_paused_payment_refused_unexplained_body',
    })
    expect(logic.buttons.map(button => [button.action, button.primary])).toEqual([
      ['raise_payment_fee', true],
      ['continue', false],
      ['replan', false],
      ['cancel', false],
    ])
  })

  it('makes no button primary when only cancelling is left', async () => {
    const { result } = await renderScreen(
      planView({ phase: 'paused', pause: { reason: 'locked' }, actions: ['cancel'] })
    )
    expect(ready(result.current).buttons).toMatchObject([{ action: 'cancel', primary: false }])
  })

  it.each<[QbitSendPlanPauseReason, string]>([
    ['locked', 'send_plan_funds_untouched'],
    ['interrupted', 'send_plan_funds_untouched'],
    ['merge_refused', 'send_plan_funds_partly_combined'],
    ['outputs_spent', 'send_plan_funds_partly_combined'],
    ['payment_fee_too_low', 'send_plan_funds_combined'],
    ['payment_refused', 'send_plan_funds_combined'],
  ])('gives the %s pause its own copy and says where the funds are', async (reason, funds) => {
    const status =
      funds === 'send_plan_funds_untouched'
        ? 'planned'
        : funds === 'send_plan_funds_partly_combined'
          ? 'broadcast'
          : 'confirmed'
    const { result } = await renderScreen(
      planView({
        phase: 'paused',
        pause: { reason, detail: 'node said: min relay fee not met' },
        steps: [
          {
            kind: 'merge',
            txid: 'aa'.repeat(32),
            inputCount: 106,
            fee: 398_827,
            status: status as any,
          },
          {
            kind: 'payment',
            txid: 'bb'.repeat(32),
            inputCount: 50,
            fee: 190_000,
            status: 'signed',
          },
        ],
        sent: status !== 'planned',
        actions: ['continue', 'cancel'],
        signing: undefined,
      })
    )
    const logic = ready(result.current)
    expect(logic.pause).toEqual({
      title: `send_plan_paused_${reason}`,
      body: `send_plan_paused_${reason}_body`,
      next: '',
      funds,
      detail: 'node said: min relay fee not met',
    })
    expect(logic.mayConfirm).toBeUndefined()
    expect(logic.note).toBe('')
  })

  it.each(UNREADABLE_VIEWS)(
    'shows %s without a figure of it, and cancels it',
    async (_label, view, detail) => {
      const harness = createHookTestHarness()
      const { result, wallet, navigation } = await renderScreen(view, harness)
      const logic = ready(result.current)
      // No amount, recipient, fee or rate is shown as the plan's, nor any stage.
      expect(logic.amount).toBe('')
      expect(logic.recipient).toBe('')
      expect(logic.fee).toBe('')
      expect(logic.stages).toEqual([])
      expect(logic.signing).toBeUndefined()
      expect(logic.note).toBe('')
      expect(logic.slowMerge).toBe('')
      expect(logic.readFailedText).toBe('')
      // Where the funds are is not known either: no line says.
      expect(logic.pause).toEqual({
        title: 'send_plan_paused_unreadable',
        body: 'send_plan_paused_unreadable_body',
        next: '',
        funds: '',
        detail,
      })
      expect(logic.mayConfirm).toBeUndefined()
      expect(logic.buttons.map(button => button.action)).toEqual(['cancel'])
      expect(logic.buttons[0]?.primary).toBe(false)
      // Nothing the screen is given holds a figure of the plan, its view included.
      const shown = JSON.stringify(logic)
      for (const figure of [
        view.recipient,
        view.paymentTxid,
        ...view.steps.map(step => step.txid),
      ]) {
        if (figure) expect(shown).not.toContain(figure)
      }

      // Cancel drops it; the background answers that no plan is left.
      wallet.cancelQbitSendPlan.mockResolvedValue(null)
      act(() => clickAction(result.current, 'cancel'))
      await act(async () => ready(result.current).cancelDialog?.onConfirm())
      expect(wallet.cancelQbitSendPlan).toHaveBeenCalledTimes(1)
      expect(wallet.cancelQbitSendPlan).toHaveBeenCalledWith(view.id)
      await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('MainScreen'))
    }
  )

  it('shows a pause it does not know as a plain pause', async () => {
    const { result } = await renderScreen(
      planView({ phase: 'paused', pause: { reason: 'new_reason' as any }, actions: ['cancel'] })
    )
    expect(ready(result.current).pause).toMatchObject({ title: 'send_plan_paused_other', body: '' })
  })

  it('says the wallet checks one transaction while it cancels', async () => {
    const { result } = await renderScreen(planView({ phase: 'cancelling', actions: [] }))
    const logic = ready(result.current)
    expect(logic.cancelling).toEqual({
      title: 'send_plan_cancelling_title',
      body: 'send_plan_cancelling_body',
      funds: 'send_plan_funds_untouched',
    })
    expect(logic.buttons).toEqual([])
  })

  describe('while a version of the payment may still go through (paymentMayConfirm)', () => {
    /** What a plan says nothing was sent with, or offers a cancel or a review again with. */
    const NOT_SENT = [
      'send_plan_funds_untouched',
      'send_plan_funds_partly_combined',
      'send_plan_funds_combined',
      'send_plan_paused_merge_refused_body',
      'send_plan_paused_outputs_spent_body',
      'send_plan_paused_payment_refused_body',
      'send_plan_paused_payment_refused_unexplained_body',
      'send_plan_cancel_body',
      'send_plan_cancel_body_untouched',
      'send_plan_action_cancel',
      'send_plan_action_replan',
    ]
    const expectNothingSaysNotSent = (logic: QbitSendPlanScreenReady): void => {
      const { plan: _plan, ...shown } = logic
      const copy = JSON.stringify(shown)
      for (const key of NOT_SENT) expect(copy).not.toContain(`"${key}`)
    }
    // The merge confirmed and the payment, sent without an answer, may still
    // confirm: the funds it uses are combined and held for it.
    const combined: QbitSendPlanView['steps'] = [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'confirmed' },
      { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'signed' },
    ]

    // What the background offers for each pause while a version may still
    // confirm (`actionsOf`): Continue, and the payment's fee raise where it
    // is offered at all; never a replan or a cancel.
    it.each<[string, QbitSendPlanPauseReason, QbitSendPlanAction[], string]>([
      ['locked, the wallet locked', 'locked', [], ''],
      ['locked, the wallet unlocked', 'locked', ['continue'], 'send_plan_may_confirm_continue'],
      ['interrupted', 'interrupted', ['continue'], 'send_plan_may_confirm_continue'],
      ['merge_refused', 'merge_refused', ['continue'], 'send_plan_may_confirm_continue'],
      ['outputs_spent', 'outputs_spent', ['continue'], 'send_plan_may_confirm_continue'],
      [
        'payment_fee_too_low',
        'payment_fee_too_low',
        ['raise_payment_fee', 'continue'],
        'send_plan_may_confirm_raise_or_continue',
      ],
      ['payment_refused', 'payment_refused', ['continue'], 'send_plan_may_confirm_continue'],
      [
        'payment_refused without a reason',
        'payment_refused',
        ['raise_payment_fee', 'continue'],
        'send_plan_may_confirm_raise_or_continue',
      ],
      ['a reason this version does not know', 'new_reason' as any, ['continue'], 'send_plan_may_confirm_continue'],
    ])(
      'says the %s pause may still go through, with only what the plan offers',
      async (_label, reason, actions, next) => {
        const { result } = await renderScreen(
          planView({
            phase: 'paused',
            pause: { reason, detail: 'node said: non-mandatory-script-verify-flag' },
            steps: combined,
            sent: true,
            paymentMayConfirm: true,
            actions,
            signing: undefined,
          })
        )
        const logic = ready(result.current)
        expect(logic.pause).toEqual({
          title: 'send_plan_may_confirm_title',
          body: 'send_plan_may_confirm_body',
          next,
          funds: 'send_plan_may_confirm_funds_combined',
          detail: 'node said: non-mandatory-script-verify-flag',
        })
        expect(logic.mayConfirm).toBeUndefined()
        // The buttons are exactly what the plan offers, the raise first when offered.
        expect(logic.buttons.map(button => button.action)).toEqual(actions)
        expect(logic.amount).toBe('0.01000000 QBT')
        expect(logic.recipient).toBe(PLAN_RECIPIENT)
        expect(logic.fee).toBe('send_plan_fee_summary:0.00588827,QBT,1')
        expectNothingSaysNotSent(logic)
      }
    )

    it.each<[string, Partial<QbitSendPlanView>]>([
      [
        'signing a raised payment',
        { phase: 'signing', signing: { step: 1, signed: 3, total: 50 }, signaturesDone: 109 },
      ],
      ['waiting for a merge a reorganisation took out', { phase: 'waiting' }],
      ['sending', { phase: 'sending' }],
      ['cancelling', { phase: 'cancelling' }],
    ])('says so while %s, where nothing is paused', async (_label, state) => {
      const { result } = await renderScreen(
        planView({
          steps: combined,
          sent: true,
          paymentMayConfirm: true,
          actions: [],
          signing: undefined,
          ...state,
        })
      )
      const logic = ready(result.current)
      expect(logic.pause).toBeUndefined()
      expect(logic.mayConfirm).toEqual({
        title: 'send_plan_may_confirm_title',
        body: 'send_plan_may_confirm_body',
        next: '',
        funds: 'send_plan_may_confirm_funds_combined',
      })
      // A cancel in progress says where the funds are only once.
      if (state.phase === 'cancelling') expect(logic.cancelling?.funds).toBe('')
      expect(logic.buttons).toEqual([])
      expectNothingSaysNotSent(logic)
    })

    it.each<[string, QbitSendPlanView['steps'], string]>([
      ['without a merge', combined.slice(1), 'send_plan_may_confirm_funds_held'],
      [
        'with a merge not confirmed again',
        [{ ...combined[0]!, status: 'broadcast' }, combined[1]!],
        'send_plan_may_confirm_funds_partly_combined',
      ],
      ['with every merge confirmed', combined, 'send_plan_may_confirm_funds_combined'],
    ])('says where the funds are, %s: in this wallet, held for the payment', async (_label, steps, funds) => {
      const { result } = await renderScreen(
        planView({
          phase: 'paused',
          pause: { reason: 'payment_refused' },
          steps,
          sent: true,
          paymentMayConfirm: true,
          actions: ['continue'],
          signing: undefined,
        })
      )
      expect(ready(result.current).pause?.funds).toBe(funds)
    })
  })

  it('continues the plan with exactly its method, once for a double tap', async () => {
    const harness = createHookTestHarness()
    const { result, wallet } = await renderScreen(
      planView({
        phase: 'paused',
        pause: { reason: 'interrupted' },
        actions: ['continue', 'cancel'],
      }),
      harness
    )
    const answer = deferred<QbitSendPlanView>()
    wallet.continueQbitSendPlan.mockReturnValue(answer.promise)

    act(() => {
      clickAction(result.current, 'continue')
      clickAction(result.current, 'continue')
    })
    expect(wallet.continueQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.continueQbitSendPlan).toHaveBeenCalledWith('plan-1')
    expect(ready(result.current).busy).toBe('continue')

    await act(async () => answer.resolve(planView({ phase: 'signing', revision: 2 })))
    expect(ready(result.current).plan.phase).toBe('signing')
    expect(ready(result.current).busy).toBeNull()
    for (const method of [
      wallet.cancelQbitSendPlan,
      wallet.dismissQbitSendPlan,
      wallet.prepareQbitSendPlan,
      wallet.startQbitSendPlan,
    ]) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  it('cancels only after the confirmation that says what cancelling does', async () => {
    const harness = createHookTestHarness()
    const { result, wallet } = await renderScreen(planView({ actions: ['cancel'] }), harness)
    wallet.cancelQbitSendPlan.mockResolvedValue(
      planView({ phase: 'cancelling', actions: [], revision: 2 })
    )

    act(() => clickAction(result.current, 'cancel'))
    expect(wallet.cancelQbitSendPlan).not.toHaveBeenCalled()
    // Nothing of this plan has been sent: cancelling changes nothing.
    expect(ready(result.current).cancelDialog).toMatchObject({
      title: 'send_plan_cancel_title',
      body: 'send_plan_cancel_body_untouched',
    })

    // Keeping the payment closes the dialog and cancels nothing.
    act(() => ready(result.current).cancelDialog?.onClose())
    expect(ready(result.current).cancelDialog).toBeUndefined()
    expect(wallet.cancelQbitSendPlan).not.toHaveBeenCalled()

    act(() => clickAction(result.current, 'cancel'))
    await act(async () => {
      ready(result.current).cancelDialog?.onConfirm()
      ready(result.current).cancelDialog?.onConfirm()
    })
    await waitFor(() => expect(ready(result.current).plan.phase).toBe('cancelling'))
    expect(wallet.cancelQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.cancelQbitSendPlan).toHaveBeenCalledWith('plan-1')
    expect(ready(result.current).cancelDialog).toBeUndefined()
  })

  it.each<[string, Partial<QbitSendPlanView>, string, string]>([
    ['nothing sent yet', {}, 'send_plan_cancel_body_untouched', 'send_plan_funds_untouched'],
    [
      'a merge sent',
      {
        steps: [
          {
            kind: 'merge',
            txid: 'aa'.repeat(32),
            inputCount: 106,
            fee: 398_827,
            status: 'broadcast',
          },
          {
            kind: 'payment',
            txid: 'bb'.repeat(32),
            inputCount: 50,
            fee: 190_000,
            status: 'planned',
          },
        ],
        sent: true,
      },
      'send_plan_cancel_body',
      'send_plan_funds_partly_combined',
    ],
    [
      'a merge whose outcome is unknown',
      {
        steps: [
          {
            kind: 'merge',
            txid: 'aa'.repeat(32),
            inputCount: 106,
            fee: 398_827,
            status: 'unknown',
          },
          {
            kind: 'payment',
            txid: 'bb'.repeat(32),
            inputCount: 50,
            fee: 190_000,
            status: 'planned',
          },
        ],
        sent: true,
      },
      'send_plan_cancel_body',
      'send_plan_funds_partly_combined',
    ],
    [
      // A new plan after a refusal: the earlier version's merges confirmed,
      // their fees count in the total, and only the payment is left.
      'fees an earlier version of the plan paid',
      {
        steps: [
          { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 4, fee: 15_000, status: 'planned' },
        ],
        totalFee: 15_000 + 398_827,
        sent: true,
      },
      'send_plan_cancel_body',
      'send_plan_funds_partly_combined',
    ],
    [
      // A raise paused before its replacement merge was signed: the view
      // lists the replacement as not signed, while the merge it replaces is
      // in the network and pays a fee.
      'a raised merge whose replacement is not signed yet',
      {
        steps: [
          {
            kind: 'merge',
            txid: 'cc'.repeat(32),
            inputCount: 106,
            fee: 797_654,
            status: 'planned',
          },
          {
            kind: 'payment',
            txid: 'dd'.repeat(32),
            inputCount: 50,
            fee: 380_000,
            status: 'planned',
          },
        ],
        totalFee: 797_654 + 380_000,
        sent: true,
      },
      'send_plan_cancel_body',
      'send_plan_funds_partly_combined',
    ],
    [
      // The view says nothing was sent: the steps alone decide nothing.
      'nothing sent, said so with steps that look sent',
      {
        steps: [
          {
            kind: 'merge',
            txid: 'aa'.repeat(32),
            inputCount: 106,
            fee: 398_827,
            status: 'confirmed',
          },
          {
            kind: 'payment',
            txid: 'bb'.repeat(32),
            inputCount: 50,
            fee: 190_000,
            status: 'planned',
          },
        ],
        sent: false,
      },
      'send_plan_cancel_body_untouched',
      'send_plan_funds_untouched',
    ],
  ])(
    'says what cancelling does to a plan with %s',
    async (_label, overrides, cancelBody, funds) => {
      const { result } = await renderScreen(
        planView({
          phase: 'paused',
          pause: { reason: 'merge_refused' },
          actions: ['replan', 'cancel'],
          signing: undefined,
          ...overrides,
        })
      )
      expect(ready(result.current).pause?.funds).toBe(funds)
      act(() => clickAction(result.current, 'cancel'))
      expect(ready(result.current).cancelDialog?.body).toBe(cancelBody)
    }
  )

  it.each(UNREADABLE_VIEWS)('says only what cancelling always does to %s', async (_label, view) => {
    const { result } = await renderScreen(view)
    act(() => clickAction(result.current, 'cancel'))
    expect(ready(result.current).cancelDialog?.body).toBe('send_plan_cancel_body')
  })

  it('closes the cancel dialog without acting once the plan no longer offers cancel', async () => {
    const harness = createHookTestHarness()
    const { result, wallet } = await renderScreen(
      planView({ actions: ['cancel'], revision: 2 }),
      harness
    )

    act(() => clickAction(result.current, 'cancel'))
    const confirm = ready(result.current).cancelDialog?.onConfirm
    expect(confirm).toBeDefined()

    // The payment went out while the dialog was open.
    wallet.getQbitSendPlan.mockResolvedValue(
      planView({ phase: 'sending', actions: [], revision: 3 })
    )
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 3 })
    })
    await waitFor(() => expect(ready(result.current).plan.phase).toBe('sending'))
    expect(ready(result.current).cancelDialog).toBeUndefined()

    // A tap that was already on its way does nothing either.
    await act(async () => confirm?.())
    expect(wallet.cancelQbitSendPlan).not.toHaveBeenCalled()
  })

  it('cancels when the plan moved on but still offers cancel', async () => {
    const harness = createHookTestHarness()
    const { result, wallet } = await renderScreen(
      planView({ actions: ['cancel'], revision: 2 }),
      harness
    )
    wallet.cancelQbitSendPlan.mockResolvedValue(null)

    act(() => clickAction(result.current, 'cancel'))
    wallet.getQbitSendPlan.mockResolvedValue(
      planView({ actions: ['cancel'], signaturesDone: 9, revision: 3 })
    )
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 3 })
    })
    await waitFor(() => expect(ready(result.current).plan.revision).toBe(3))
    expect(ready(result.current).cancelDialog).toBeDefined()

    await act(async () => ready(result.current).cancelDialog?.onConfirm())
    expect(wallet.cancelQbitSendPlan).toHaveBeenCalledWith('plan-1')
  })

  it('goes home once no plan is left, as after a cancel that settled', async () => {
    const harness = createHookTestHarness()
    const { result, wallet, navigation } = await renderScreen(
      planView({ actions: ['cancel'] }),
      harness
    )
    wallet.cancelQbitSendPlan.mockResolvedValue(null)

    act(() => clickAction(result.current, 'cancel'))
    await act(async () => ready(result.current).cancelDialog?.onConfirm())
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('MainScreen'))
    expect(navigation.replace).toHaveBeenCalledTimes(1)
  })

  it('goes home when the account has no plan', async () => {
    const { navigation, result } = await renderScreen(null)
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('MainScreen'))
    expect(result.current.ready).toBe(false)
  })

  it("hands a completed plan to the success screen for its payment's transaction", async () => {
    const { navigation } = await renderScreen(
      planView({ phase: 'completed', actions: ['dismiss'], paymentTxid: 'cc'.repeat(32) })
    )
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('TxSuccessScreen', {
        txid: 'cc'.repeat(32),
        sendPlanId: 'plan-1',
      })
    )
    expect(navigation.replace).toHaveBeenCalledTimes(1)
  })

  it('dismisses with exactly its method, then goes home', async () => {
    const harness = createHookTestHarness()
    const { result, wallet, navigation } = await renderScreen(
      planView({ phase: 'paused', pause: { reason: 'interrupted' }, actions: ['dismiss'] }),
      harness
    )
    await act(async () => clickAction(result.current, 'dismiss'))
    expect(wallet.dismissQbitSendPlan).toHaveBeenCalledWith('plan-1')
    expect(navigation.replace).toHaveBeenCalledWith('MainScreen')
    expect(wallet.cancelQbitSendPlan).not.toHaveBeenCalled()
  })

  describe('reviewing the payment again', () => {
    const refusedMerge = (feeRate: number) =>
      planView({
        phase: 'paused',
        pause: { reason: 'merge_refused' },
        actions: ['replan', 'cancel'],
        feeRate,
      })
    const replanReview = planReview({
      revises: { planId: 'plan-1', kind: 'replan' },
      previousAmount: 1_000_000,
    })

    it('chooses the rate in its own dialog, starting from the plan’s own', async () => {
      const harness = createHookTestHarness()
      const { result, wallet, navigation, store } = await renderScreen(refusedMerge(2.5), harness)
      wallet.prepareQbitSendPlan.mockResolvedValue({ ok: true, review: replanReview })

      act(() => clickAction(result.current, 'replan'))
      // Nothing is prepared before the rate is chosen.
      expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
      expect(ready(result.current).replanDialog).toMatchObject({
        title: 'send_plan_replan_title',
        body: 'send_plan_replan_body:2.5',
        canReview: true,
      })
      // The fee bar starts at the plan's rate, as a rate of the user's own.
      expect(store.getState().ui.feeRateBar).toMatchObject({
        feeOptionIndex: 3,
        feeRateInputVal: '2.5',
        feeRate: 2.5,
      })

      // A higher rate, so the network takes what it refused at the plan's.
      act(() => {
        store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 4, feeRateInputVal: '4' }))
      })
      await waitFor(() => expect(ready(result.current).replanDialog?.canReview).toBe(true))
      await act(async () => ready(result.current).replanDialog?.onReview())
      expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
      expect(wallet.prepareQbitSendPlan).toHaveBeenCalledWith({
        to: PLAN_RECIPIENT,
        target: { kind: 'amount', amount: 1_000_000 },
        feeRate: 4,
        revise: { planId: 'plan-1', kind: 'replan' },
      })
      // With the plan it revises as shown, for the review to compare with.
      expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanReviewScreen', {
        review: replanReview,
        revised: { paymentTxid: 'bb'.repeat(32), feeRate: 2.5, totalFee: 588_827 },
      })
      expect(ready(result.current).replanDialog).toBeUndefined()
      expect(wallet.startQbitSendPlan).not.toHaveBeenCalled()
    })

    it('keeps the plan’s own rate, or a lower one, when the user chooses it', async () => {
      const harness = createHookTestHarness()
      const { result, wallet, store } = await renderScreen(refusedMerge(2.5), harness)
      wallet.prepareQbitSendPlan.mockResolvedValue({ ok: true, review: replanReview })

      act(() => clickAction(result.current, 'replan'))
      await act(async () => ready(result.current).replanDialog?.onReview())
      expect(wallet.prepareQbitSendPlan.mock.calls[0]?.[0]).toMatchObject({ feeRate: 2.5 })

      act(() => clickAction(result.current, 'replan'))
      act(() => {
        store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 1, feeRateInputVal: '1' }))
      })
      await waitFor(() => expect(ready(result.current).replanDialog?.canReview).toBe(true))
      await act(async () => ready(result.current).replanDialog?.onReview())
      expect(wallet.prepareQbitSendPlan.mock.calls[1]?.[0]).toMatchObject({ feeRate: 1 })
    })

    it('says why a revision cannot be prepared', async () => {
      const harness = createHookTestHarness()
      const { result, wallet, navigation } = await renderScreen(
        planView({
          target: 'everything',
          phase: 'paused',
          pause: { reason: 'outputs_spent' },
          actions: ['replan'],
        }),
        harness
      )
      wallet.prepareQbitSendPlan.mockResolvedValue({
        ok: false,
        reason: 'insufficient_balance',
        maxSendable: 0,
        unconfirmedSatoshis: 0,
      })

      act(() => clickAction(result.current, 'replan'))
      await act(async () => ready(result.current).replanDialog?.onReview())
      expect(wallet.prepareQbitSendPlan.mock.calls[0]?.[0]).toMatchObject({
        target: { kind: 'everything' },
      })
      expect(ready(result.current).actionError).toBe('send_plan_short_of_fees')
      expect(navigation.navigate).not.toHaveBeenCalled()
    })

    it('refuses a rate below the floor in its dialog, and prepares nothing', async () => {
      const harness = createHookTestHarness()
      const { result, wallet } = await renderScreen(refusedMerge(0.1), harness)

      act(() => clickAction(result.current, 'replan'))
      await waitFor(() => expect(ready(result.current).replanDialog?.error).not.toBe(''))
      expect(ready(result.current).replanDialog?.canReview).toBe(false)
      await act(async () => ready(result.current).replanDialog?.onReview())
      expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
    })

    it('closes without acting', async () => {
      const harness = createHookTestHarness()
      const { result, wallet } = await renderScreen(refusedMerge(2.5), harness)
      act(() => clickAction(result.current, 'replan'))
      act(() => ready(result.current).replanDialog?.onClose())
      expect(ready(result.current).replanDialog).toBeUndefined()
      expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
    })
  })

  it('raises a fee only at a rate above the plan’s, chosen in its own dialog', async () => {
    const harness = createHookTestHarness()
    // A Custom rate, the user's own, settles at once.
    harness.store.dispatch(
      (uiActions as any).updateFeeRateBar({ feeRate: 1, feeRateInputVal: '1', feeOptionIndex: 3 })
    )
    const { result, wallet, navigation, store } = await renderScreen(
      planView({
        phase: 'paused',
        pause: { reason: 'payment_fee_too_low' },
        actions: ['raise_payment_fee', 'cancel'],
        feeRate: 2,
      }),
      harness
    )
    const review = planReview({ revises: { planId: 'plan-1', kind: 'raise_payment_fee' } })
    wallet.prepareQbitSendPlan.mockResolvedValue({ ok: true, review })

    act(() => clickAction(result.current, 'raise_payment_fee'))
    expect(ready(result.current).raiseDialog).toMatchObject({
      title: 'send_plan_raise_title',
      body: 'send_plan_raise_body:2',
      canReview: false,
    })
    // The plan's own rate is no raise.
    act(() => {
      store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 2, feeRateInputVal: '2' }))
    })
    await waitFor(() => expect(ready(result.current).raiseDialog?.canReview).toBe(false))
    await act(async () => ready(result.current).raiseDialog?.onReview())
    expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()

    act(() => {
      store.dispatch((uiActions as any).updateFeeRateBar({ feeRate: 3.5, feeRateInputVal: '3.5' }))
    })
    await waitFor(() => expect(ready(result.current).raiseDialog?.canReview).toBe(true))
    await act(async () => ready(result.current).raiseDialog?.onReview())
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledWith({
      to: PLAN_RECIPIENT,
      target: { kind: 'amount', amount: 1_000_000 },
      feeRate: 3.5,
      revise: { planId: 'plan-1', kind: 'raise_payment_fee' },
    })
    // With the plan it revises as shown, for the review to compare with.
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanReviewScreen', {
      review,
      revised: { paymentTxid: 'bb'.repeat(32), feeRate: 2, totalFee: 588_827 },
    })
    expect(ready(result.current).raiseDialog).toBeUndefined()
  })

  it('names the lowest rate that works when a raise cannot replace what was sent', async () => {
    const harness = createHookTestHarness()
    harness.store.dispatch(
      (uiActions as any).updateFeeRateBar({
        feeRate: 2.5,
        feeRateInputVal: '2.5',
        feeOptionIndex: 3,
      })
    )
    const { result, wallet, navigation } = await renderScreen(
      planView({ phase: 'waiting', slowMerge: true, actions: ['raise_merge_fee'], feeRate: 2 }),
      harness
    )
    wallet.prepareQbitSendPlan.mockResolvedValue({
      ok: false,
      reason: 'fee_rate_too_low',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
      minimumFeeRate: 3.01,
    })
    act(() => clickAction(result.current, 'raise_merge_fee'))
    await waitFor(() => expect(ready(result.current).raiseDialog?.canReview).toBe(true))
    await act(async () => ready(result.current).raiseDialog?.onReview())
    expect(ready(result.current).actionError).toBe('send_plan_fee_rate_too_low:3.01')
    expect(navigation.navigate).not.toHaveBeenCalled()

    // Without a usable rate in the answer the refusal stays general.
    wallet.prepareQbitSendPlan.mockResolvedValue({
      ok: false,
      reason: 'fee_rate_too_low',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
      minimumFeeRate: null,
    })
    await act(async () => ready(result.current).raiseDialog?.onReview())
    expect(ready(result.current).actionError).toBe('send_plan_revise_refused')
  })

  it('refuses a Custom rate below the floor in the raise dialog', async () => {
    const harness = createHookTestHarness()
    harness.store.dispatch(
      (uiActions as any).updateFeeRateBar({
        feeRate: 0.1,
        feeRateInputVal: '0.1',
        feeOptionIndex: 3,
      })
    )
    const { result } = await renderScreen(
      planView({ phase: 'waiting', slowMerge: true, actions: ['raise_merge_fee'], feeRate: 0.05 }),
      harness
    )
    // The dialog reads the fee quote its bar offers rates from.
    await act(async () => clickAction(result.current, 'raise_merge_fee'))
    await waitFor(() => expect(harness.wallet.getFeeSummary).toHaveBeenCalled())
    expect(ready(result.current).raiseDialog).toMatchObject({
      error: 'fee_rate_below_minimum:0.25',
      canReview: false,
    })
  })

  it('shows a failed call and reads the plan again to see where it stands', async () => {
    const harness = createHookTestHarness()
    const { result, wallet } = await renderScreen(
      planView({ phase: 'paused', pause: { reason: 'interrupted' }, actions: ['continue'] }),
      harness
    )
    wallet.continueQbitSendPlan.mockRejectedValue({ message: 'The wallet is locked.' })
    const reads = wallet.getQbitSendPlan.mock.calls.length

    await act(async () => clickAction(result.current, 'continue'))
    expect(ready(result.current).actionError).toBe('The wallet is locked.')
    await waitFor(() => expect(wallet.getQbitSendPlan.mock.calls.length).toBe(reads + 1))
    expect(ready(result.current).busy).toBeNull()
  })

  it('goes home from Back and stops nothing', async () => {
    const harness = createHookTestHarness()
    const { result, wallet, navigation } = await renderScreen(planView(), harness)
    act(() => ready(result.current).onClickBack())
    expect(navigation.navigate).toHaveBeenCalledWith('MainScreen')
    expect(wallet.cancelQbitSendPlan).not.toHaveBeenCalled()
  })
})

describe('useQbitSendPlanEntryLogic', () => {
  async function renderEntry(plan: QbitSendPlanView | null) {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(plan)
    const { wrapper } = recordingI18n(harness.wrapper)
    const rendered = renderHook(() => useQbitSendPlanEntryLogic(), { wrapper })
    await waitFor(() => expect(harness.wallet.getQbitSendPlan).toHaveBeenCalled())
    if (plan) await waitFor(() => expect(rendered.result.current).toBeDefined())
    return { ...harness, ...rendered }
  }

  it('shows nothing without a plan', async () => {
    const { result } = await renderEntry(null)
    await act(async () => {})
    expect(result.current).toBeUndefined()
  })

  it('titles a plan in progress with what it sends and opens the progress screen', async () => {
    const { result, navigation } = await renderEntry(planView({ signaturesDone: 20 }))
    expect(result.current).toMatchObject({
      title: 'send_plan_home_sending:0.01000000,QBT',
      status: 'send_plan_status_signing:20,156',
      tone: 'progress',
      buttonText: 'view',
    })
    act(() => result.current?.onClickOpen())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
  })

  it('says a paused plan needs the user, with the reason', async () => {
    const { result } = await renderEntry(
      planView({
        phase: 'paused',
        pause: { reason: 'payment_fee_too_low' },
        actions: ['raise_payment_fee'],
      })
    )
    expect(result.current).toMatchObject({
      title: 'send_plan_home_paused:0.01000000,QBT',
      status: 'send_plan_paused_payment_fee_too_low',
      tone: 'paused',
    })
  })

  it.each(UNREADABLE_VIEWS)('says %s needs the user, without an amount', async (_label, view) => {
    const { result, navigation } = await renderEntry(view)
    expect(result.current).toEqual({
      title: 'send_plan_paused_unreadable',
      status: 'send_plan_paused_unreadable_body',
      tone: 'paused',
      buttonText: 'view',
      onClickOpen: expect.any(Function),
    })
    act(() => result.current?.onClickOpen())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
  })

  it('names a refusal without a reason as such on the home card', async () => {
    const { result } = await renderEntry(
      planView({
        phase: 'paused',
        pause: { reason: 'payment_refused' },
        actions: ['raise_payment_fee', 'continue', 'replan', 'cancel'],
      })
    )
    expect(result.current).toMatchObject({
      title: 'send_plan_home_paused:0.01000000,QBT',
      status: 'send_plan_paused_payment_refused_unexplained',
      tone: 'paused',
    })
  })

  it('counts the funds combined while it waits', async () => {
    const { result } = await renderEntry(
      planView({
        phase: 'waiting',
        steps: [
          { kind: 'merge', txid: 'a1'.repeat(32), inputCount: 106, fee: 1, status: 'confirmed' },
          { kind: 'merge', txid: 'a2'.repeat(32), inputCount: 106, fee: 1, status: 'broadcast' },
          { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 2, fee: 1, status: 'signed' },
        ],
        sent: true,
      })
    )
    expect(result.current?.status).toBe('send_plan_status_waiting:1,2')
  })

  it('opens the success screen for a sent payment, which removes the plan once left', async () => {
    const { result, navigation } = await renderEntry(
      planView({ phase: 'completed', actions: ['dismiss'], paymentTxid: 'cc'.repeat(32) })
    )
    expect(result.current).toMatchObject({
      title: 'send_plan_home_sent:0.01000000,QBT',
      status: 'send_plan_status_sent',
      tone: 'sent',
    })
    act(() => result.current?.onClickOpen())
    expect(navigation.navigate).toHaveBeenCalledWith('TxSuccessScreen', {
      txid: 'cc'.repeat(32),
      sendPlanId: 'plan-1',
    })
  })

  it.each<[string, Partial<QbitSendPlanView>, string, string]>([
    [
      'paused',
      { phase: 'paused', pause: { reason: 'payment_refused' }, actions: ['continue'] },
      'send_plan_home_paused:0.01000000,QBT',
      'paused',
    ],
    ['signing', { phase: 'signing', actions: [] }, 'send_plan_home_sending:0.01000000,QBT', 'progress'],
    ['waiting', { phase: 'waiting', actions: [] }, 'send_plan_home_sending:0.01000000,QBT', 'progress'],
    ['sending', { phase: 'sending', actions: [] }, 'send_plan_home_sending:0.01000000,QBT', 'progress'],
  ])(
    'says a payment that may still go through may, while %s, and not to pay the recipient another way',
    async (_label, state, title, tone) => {
      const { result } = await renderEntry(
        planView({ sent: true, paymentMayConfirm: true, signing: undefined, ...state })
      )
      expect(result.current).toMatchObject({ title, status: 'send_plan_status_may_confirm', tone })
    }
  )

  it('says a sent payment was sent, whatever a version of it may still do', async () => {
    const { result } = await renderEntry(
      planView({ phase: 'completed', actions: ['dismiss'], sent: true, paymentMayConfirm: true })
    )
    expect(result.current).toMatchObject({ status: 'send_plan_status_sent', tone: 'sent' })
  })

  it('says a cancel is being settled', async () => {
    const { result } = await renderEntry(planView({ phase: 'cancelling', actions: [] }))
    expect(result.current).toMatchObject({
      title: 'send_plan_home_cancelling:0.01000000,QBT',
      status: 'send_plan_cancelling_body',
    })
  })
})
