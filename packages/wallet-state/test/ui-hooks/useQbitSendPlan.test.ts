import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BUS_METHODS, type QbitSendPlanView } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { QBIT_SEND_PLAN_POLL_MS, useQbitSendPlan } from '../../src/hooks/sendPlan'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { uiEventBus } from '../../src/utils/eventBus'
import {
  PLAN_ACCOUNT,
  deferred,
  planView,
  refusedPlanView,
  unreadablePlanView,
  unreadableShown,
} from './sendPlanFixtures'
import { createHookTestHarness } from './testHelpers'

function renderPlan(harness = createHookTestHarness()) {
  const rendered = renderHook(() => useQbitSendPlan(), { wrapper: harness.wrapper })
  return { ...harness, ...rendered }
}

function otherAccount(address: string) {
  return {
    type: 'HD Key Tree',
    address,
    brandName: 'Qbit',
    alianName: 'Account 2',
    displayBrandName: 'Qbit',
    index: 1,
    balance: 0,
    pubkey: '02def456',
    key: `account-${address}`,
    flag: 0,
  } as any
}

describe('useQbitSendPlan', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the plan on mount, and knows nothing before the read lands', async () => {
    const harness = createHookTestHarness()
    const read = deferred<QbitSendPlanView | null>()
    harness.wallet.getQbitSendPlan.mockReturnValueOnce(read.promise)
    const { result } = renderPlan(harness)

    expect(result.current.plan).toBeUndefined()
    expect(harness.wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)

    await act(async () => read.resolve(planView({ revision: 2 })))
    expect(result.current.plan).toMatchObject({ id: 'plan-1', revision: 2 })
    expect(result.current.readFailed).toBe(false)
  })

  it('shows no plan when the account has none', async () => {
    const { result, wallet } = renderPlan()
    await waitFor(() => expect(result.current.plan).toBeNull())
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it('reads again on every change event, but not for a revision already shown', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(planView({ revision: 4 }))
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.revision).toBe(4))

    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 4 })
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)

    wallet.getQbitSendPlan.mockResolvedValue(planView({ revision: 5, signaturesDone: 10 }))
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 5 })
    })
    await waitFor(() => expect(result.current.plan?.revision).toBe(5))
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)

    // Another plan's event, or one that names nothing, is read too.
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-2', revision: 1 })
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)
  })

  it('drops a view of the shown plan with a lower revision', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(
      planView({ revision: 5, signaturesDone: 50 })
    )
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.revision).toBe(5))

    wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ revision: 3, signaturesDone: 30 }))
    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2))
    expect(result.current.plan).toMatchObject({ revision: 5, signaturesDone: 50 })
  })

  it('keeps one read at a time and reads once more for the changes asked for meanwhile', async () => {
    const harness = createHookTestHarness()
    const first = deferred<QbitSendPlanView | null>()
    harness.wallet.getQbitSendPlan.mockReturnValueOnce(first.promise)
    const { result, wallet } = renderPlan(harness)

    act(() => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 2 })
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 3 })
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)

    wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ revision: 3 }))
    await act(async () => first.resolve(planView({ revision: 1 })))
    await waitFor(() => expect(result.current.plan?.revision).toBe(3))
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
  })

  it('never lets an earlier call bring back a plan a later read found gone', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ revision: 2 }))
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.revision).toBe(2))

    const cancel = deferred<QbitSendPlanView | null>()
    let applied: Promise<unknown> | undefined
    act(() => {
      applied = result.current.apply(
        () => cancel.promise,
        view => view
      )
    })
    wallet.getQbitSendPlan.mockResolvedValueOnce(null)
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 4 })
    })
    await waitFor(() => expect(result.current.plan).toBeNull())

    await act(async () => {
      cancel.resolve(planView({ revision: 3, phase: 'cancelling' }))
      await applied
    })
    expect(result.current.plan).toBeNull()
  })

  it("shows a call's answer when it is the newer revision of the plan shown", async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ revision: 2, phase: 'paused' }))
    const { result } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.revision).toBe(2))

    await act(async () => {
      await result.current.apply(
        async () => planView({ revision: 3, phase: 'signing' }),
        view => view
      )
    })
    expect(result.current.plan).toMatchObject({ revision: 3, phase: 'signing' })
  })

  it('drops a plan that names another account, and every answer for the account left', async () => {
    const harness = createHookTestHarness()
    const forFirst = deferred<QbitSendPlanView | null>()
    harness.wallet.getQbitSendPlan.mockReturnValueOnce(forFirst.promise)
    const { result, wallet, store } = renderPlan(harness)

    wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ id: 'plan-b', address: 'qb1zsecond' }))
    act(() => {
      store.dispatch((accountActions as any).setCurrent(otherAccount('qb1zsecond')))
    })
    await waitFor(() => expect(result.current.plan?.id).toBe('plan-b'))
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)

    // The first account's answer lands late: it is not this account's.
    await act(async () => forFirst.resolve(planView({ id: 'plan-a', address: PLAN_ACCOUNT })))
    expect(result.current.plan?.id).toBe('plan-b')

    // An answer naming another account than the selected one is not shown.
    wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ id: 'plan-a', address: PLAN_ACCOUNT }))
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED)
    })
    await waitFor(() => expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3))
    expect(result.current.plan?.id).toBe('plan-b')
  })

  it('reads again on a network change and forgets the plan of the network left', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(planView())
    const { result, wallet, store } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.id).toBe('plan-1'))

    const forTestnet = deferred<QbitSendPlanView | null>()
    wallet.getQbitSendPlan.mockReturnValueOnce(forTestnet.promise)
    act(() => {
      store.dispatch(
        (settingsActions as any).updateSettings({ chainType: ChainType.QBIT_TESTNET4 })
      )
    })
    // Nothing of the mainnet plan is shown while testnet's is read.
    expect(result.current.plan).toBeUndefined()
    await act(async () => forTestnet.resolve(null))
    expect(result.current.plan).toBeNull()

    wallet.getQbitSendPlan.mockResolvedValueOnce(null)
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.CHAIN_CHANGED, { type: ChainType.QBIT_TESTNET4 })
    })
    await waitFor(() => expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3))
  })

  it('polls every 5 seconds while the plan is open, and stops once it completed', async () => {
    vi.useFakeTimers()
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(planView({ phase: 'waiting', revision: 2 }))
    const { result, wallet } = renderPlan(harness)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.plan?.phase).toBe('waiting')
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QBIT_SEND_PLAN_POLL_MS)
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)

    wallet.getQbitSendPlan.mockResolvedValue(planView({ phase: 'completed', revision: 3 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QBIT_SEND_PLAN_POLL_MS)
    })
    expect(result.current.plan?.phase).toBe('completed')
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QBIT_SEND_PLAN_POLL_MS * 3)
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)
  })

  it('does not poll without a plan, and retries a read that failed', async () => {
    vi.useFakeTimers()
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(null)
    const { result, wallet } = renderPlan(harness)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QBIT_SEND_PLAN_POLL_MS * 2)
    })
    expect(result.current.plan).toBeNull()
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)

    wallet.getQbitSendPlan.mockRejectedValueOnce({ message: 'port closed' })
    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.readFailed).toBe(true)
    // The last plan known stays: there was none.
    expect(result.current.plan).toBeNull()

    wallet.getQbitSendPlan.mockResolvedValueOnce(planView())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QBIT_SEND_PLAN_POLL_MS)
    })
    expect(result.current.readFailed).toBe(false)
    expect(result.current.plan?.id).toBe('plan-1')
  })

  it('counts an answer that is not a plan as a failed read and keeps the plan shown', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ revision: 2 }))
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.revision).toBe(2))

    wallet.getQbitSendPlan.mockResolvedValueOnce({ id: 'plan-1', revision: 'three' })
    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => expect(result.current.readFailed).toBe(true))
    expect(result.current.plan?.revision).toBe(2)
  })

  it('shows the stand-in for a stored plan the background cannot read, with its cancel', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(unreadablePlanView('stored-1'))
    const { result } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan).toBeTruthy())
    expect(result.current.plan).toEqual(unreadablePlanView('stored-1'))
    expect(result.current.readFailed).toBe(false)
  })

  it.each([
    ['a merge', refusedPlanView('merge')],
    ['the payment, once the merge went out', refusedPlanView('payment')],
  ])(
    'shows a stored plan whose check refused %s as the stand-in is shown: its pause and cancel, none of its figures',
    async (_label, answer) => {
      const harness = createHookTestHarness()
      harness.wallet.getQbitSendPlan.mockResolvedValue(answer)
      const { result } = renderPlan(harness)
      await waitFor(() => expect(result.current.plan).toBeTruthy())
      expect(result.current.readFailed).toBe(false)
      expect(result.current.plan).toEqual(unreadableShown(answer))
      expect(result.current.plan).toMatchObject({
        id: answer.id,
        recipient: '',
        amount: 0,
        change: 0,
        feeRate: 0,
        totalFee: 0,
        steps: [],
        signaturesDone: 0,
        signaturesTotal: 0,
        paymentTxid: '',
        phase: 'paused',
        pause: { reason: 'unreadable', detail: answer.pause?.detail },
        actions: ['cancel'],
        // Whether anything of it was sent is the background's to say.
        sent: answer.sent,
      })
    }
  )

  it('orders the views of a plan paused unreadable by its revision, as any plan', async () => {
    const harness = createHookTestHarness()
    // The same plan signing, as the background showed it before its check refused the merge.
    const refused = refusedPlanView('merge')
    const signing = {
      ...refused,
      phase: 'signing',
      pause: undefined,
      revision: refused.revision - 1,
    }
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(signing)
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.phase).toBe('signing'))

    // The check refuses the merge: the pause replaces the signing shown.
    const late = deferred<unknown>()
    wallet.getQbitSendPlan.mockReturnValueOnce(late.promise)
    act(() => {
      result.current.refresh()
    })
    await act(async () => {
      await result.current.apply(
        async () => refusedPlanView('merge'),
        view => view
      )
    })
    expect(result.current.plan).toEqual(unreadableShown(refusedPlanView('merge')))

    // A read that started before the pause and lands after it is dropped.
    await act(async () => late.resolve(signing))
    expect(result.current.plan).toEqual(unreadableShown(refusedPlanView('merge')))
    expect(result.current.readFailed).toBe(false)
  })

  it.each<[string, unknown]>([
    ['a plan without a recipient', { ...planView(), recipient: '' }],
    ['a plan without a fee rate', { ...planView(), feeRate: 0 }],
    [
      'a paused plan without a recipient',
      { ...planView({ phase: 'paused', pause: { reason: 'payment_refused' } }), recipient: '' },
    ],
    [
      'a paused plan without a fee rate',
      { ...planView({ phase: 'paused', pause: { reason: 'payment_fee_too_low' } }), feeRate: 0 },
    ],
    [
      'the stand-in with a recipient',
      {
        ...unreadablePlanView(),
        recipient: 'qb1zrecipient0000000000000000000000000000000000000000000',
      },
    ],
    ['the stand-in with a fee rate', { ...unreadablePlanView(), feeRate: 1 }],
    ['the stand-in with an amount', { ...unreadablePlanView(), amount: 1_000 }],
    ['the stand-in with steps', { ...unreadablePlanView(), steps: planView().steps }],
    ['the stand-in while signing', { ...unreadablePlanView(), phase: 'signing' }],
    ['the stand-in saying something was sent', { ...unreadablePlanView(), sent: true }],
    ['the stand-in without sent', { ...unreadablePlanView(), sent: undefined }],
    ['a plan without sent', { ...planView(), sent: undefined }],
    ['a plan whose sent is not a boolean', { ...planView(), sent: 'yes' }],
    ['a plan whose sent is a number', { ...planView(), sent: 1 }],
    ['a plan whose sent crossed the port as null', { ...planView(), sent: null }],
    // A stored plan a check refused is read only as the whole plan it is.
    ['a refused plan without a recipient', { ...refusedPlanView('merge'), recipient: '' }],
    ['a refused plan without a fee rate', { ...refusedPlanView('merge'), feeRate: 0 }],
    [
      'a refused plan whose fee rate crossed the port as null',
      { ...refusedPlanView('payment'), feeRate: null },
    ],
    ['a refused plan with an amount that is no count', { ...refusedPlanView('merge'), amount: -1 }],
    [
      'a refused plan with a step that is not one',
      { ...refusedPlanView('payment'), steps: [{ kind: 'merge', txid: 'aa'.repeat(32) }] },
    ],
    ['a refused plan without sent', { ...refusedPlanView('payment'), sent: undefined }],
    ['a refused plan without a revision', { ...refusedPlanView('merge'), revision: undefined }],
    // Whether a version of the payment may still confirm is said only as true.
    ['a plan whose paymentMayConfirm is false', { ...planView(), paymentMayConfirm: false }],
    [
      'a plan whose paymentMayConfirm crossed the port as null',
      { ...planView(), paymentMayConfirm: null },
    ],
    ['a plan whose paymentMayConfirm is a string', { ...planView(), paymentMayConfirm: 'true' }],
    ['a plan whose paymentMayConfirm is a number', { ...planView(), paymentMayConfirm: 1 }],
    // Nor of a plan paused unreadable, which states nothing of its payment.
    [
      'the stand-in saying a version of its payment may still confirm',
      { ...unreadablePlanView(), paymentMayConfirm: true },
    ],
    [
      'a refused plan saying a version of its payment may still confirm',
      { ...refusedPlanView('payment'), paymentMayConfirm: true },
    ],
  ])('still counts %s as a failed read', async (_label, answer) => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(answer)
    const { result } = renderPlan(harness)
    await waitFor(() => expect(result.current.readFailed).toBe(true))
    expect(result.current.plan).toBeUndefined()
  })

  it.each([
    ['the stand-in', unreadablePlanView()],
    ['a stored plan its check refused', refusedPlanView('payment')],
  ])('offers only cancel for a plan paused unreadable: %s', async (_label, view) => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce({
      ...view,
      actions: ['continue', 'replan', 'raise_payment_fee', 'raise_merge_fee', 'cancel'],
      slowMerge: true,
    })
    const { result } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan).toBeTruthy())
    expect(result.current.plan?.actions).toEqual(['cancel'])
    expect(result.current.plan?.slowMerge).toBeUndefined()
  })

  it('reads that a version of the payment may still confirm as the background says it: true, or not at all', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(
      planView({
        phase: 'paused',
        pause: { reason: 'payment_refused' },
        actions: ['continue'],
        sent: true,
        paymentMayConfirm: true,
      })
    )
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan).toBeTruthy())
    expect(result.current.plan?.paymentMayConfirm).toBe(true)

    // Settled: the next view says nothing of it.
    wallet.getQbitSendPlan.mockResolvedValueOnce(planView({ revision: 2 }))
    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => expect(result.current.plan?.revision).toBe(2))
    expect(result.current.plan).not.toHaveProperty('paymentMayConfirm')
    expect(result.current.readFailed).toBe(false)
  })

  it('offers no action this version does not know', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce({
      ...planView(),
      actions: ['cancel', 'send_twice', 'continue'],
    })
    const { result } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan).toBeTruthy())
    expect(result.current.plan?.actions).toEqual(['continue', 'cancel'])
  })
})
