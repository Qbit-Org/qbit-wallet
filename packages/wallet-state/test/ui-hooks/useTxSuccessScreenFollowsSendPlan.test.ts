import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BUS_METHODS, type QbitSendPlanView } from '@qbit/wallet-shared'

import { QBIT_SEND_PLAN_POLL_MS } from '../../src/hooks/sendPlan'
import { useTxSuccessScreenLogic } from '../../src/ui-hooks/useTxSuccessScreenLogic'
import { uiEventBus } from '../../src/utils/eventBus'
import { planView } from './sendPlanFixtures'
import { createHookTestHarness, createNavigationMock } from './testHelpers'

// The success screen of a send plan follows that plan (#217): until the
// transaction it names has confirmed, the plan can name another one, which
// replaced it, or reopen as paused. The screen shows and links the one the
// plan names, and gives way to the plan screen once the plan is no longer
// completed. Without a plan, or for an ordinary send, it shows what it was
// opened with.

const T = '11'.repeat(32)
const T2 = '22'.repeat(32)

/** The plan completed, naming `txid` as what paid the recipient, not confirmed yet. */
function completedView(txid: string, revision: number): QbitSendPlanView {
  return planView({
    phase: 'completed',
    revision,
    actions: ['dismiss'],
    signing: undefined,
    signaturesDone: 156,
    sent: true,
    paymentTxid: txid,
    steps: [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'confirmed' },
      { kind: 'payment', txid, inputCount: 50, fee: 3_000, status: 'broadcast' },
    ],
  })
}

/** The plan reopened as paused. */
function reopenedView(revision: number): QbitSendPlanView {
  return planView({
    phase: 'paused',
    pause: { reason: 'interrupted' },
    revision,
    actions: ['continue'],
    signing: undefined,
    sent: true,
    paymentMayConfirm: true,
  })
}

/** Time passes for the page's reads, and they land. */
async function reads(times = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(QBIT_SEND_PLAN_POLL_MS * times)
  })
}

function renderSuccess(route: Record<string, unknown>, plan: QbitSendPlanView | null) {
  const navigation = createNavigationMock(route)
  const harness = createHookTestHarness({ navigation })
  harness.wallet.getQbitSendPlan.mockResolvedValue(plan)
  const rendered = renderHook(() => useTxSuccessScreenLogic(), { wrapper: harness.wrapper })
  return { ...harness, ...rendered }
}

describe('the success screen of a send plan', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows and links the transaction the plan names now, when it names another than the one shown', async () => {
    vi.useFakeTimers()
    const { result, wallet, navigation } = renderSuccess(
      { txid: T, sendPlanId: 'plan-1' },
      completedView(T, 3)
    )
    await reads(0)
    expect(result.current.txid).toBe(T)

    wallet.getQbitSendPlan.mockResolvedValue(completedView(T2, 4))
    await reads()
    expect(result.current.txid).toBe(T2)
    act(() => {
      result.current.txAction.onClick()
    })
    expect(navigation.navToUrl).toHaveBeenLastCalledWith(`https://mempool.qbit.org/tx/${T2}`)
    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it('gives way to the plan screen once the plan reopens as paused', async () => {
    vi.useFakeTimers()
    const { wallet, navigation } = renderSuccess(
      { txid: T, sendPlanId: 'plan-1' },
      completedView(T, 3)
    )
    await reads(0)
    expect(navigation.replace).not.toHaveBeenCalled()

    wallet.getQbitSendPlan.mockResolvedValue(reopenedView(4))
    await reads()
    expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
  })

  it('sends no dismiss when it gives way to the plan screen, though the plan is completed again by the time it goes', async () => {
    vi.useFakeTimers()
    const { wallet, navigation, unmount } = renderSuccess(
      { txid: T, sendPlanId: 'plan-1' },
      completedView(T, 3)
    )
    await reads(0)
    // Paused for a moment, then completed again naming T.
    wallet.getQbitSendPlan.mockResolvedValueOnce(reopenedView(4))
    wallet.getQbitSendPlan.mockResolvedValue(completedView(T, 5))
    await reads()
    expect(navigation.replace).toHaveBeenCalledWith('QbitSendPlanScreen')
    // The navigation takes the screen away.
    unmount()
    await reads(0)
    expect(wallet.dismissQbitSendPlan).not.toHaveBeenCalled()
  })

  it('still sends a dismiss when the user leaves a plan it shows completed', async () => {
    vi.useFakeTimers()
    const { wallet, unmount } = renderSuccess(
      { txid: T, sendPlanId: 'plan-1' },
      completedView(T, 3)
    )
    await reads(0)
    unmount()
    await reads(0)
    expect(wallet.dismissQbitSendPlan).toHaveBeenCalledWith('plan-1')
  })

  it('shows what it was opened with when the plan is gone, and for another plan or an ordinary send', async () => {
    vi.useFakeTimers()
    const gone = renderSuccess({ txid: T, sendPlanId: 'plan-1' }, null)
    await reads(0)
    expect(gone.result.current.txid).toBe(T)
    expect(gone.navigation.replace).not.toHaveBeenCalled()
    gone.unmount()

    const another = renderSuccess({ txid: T, sendPlanId: 'plan-2' }, reopenedView(4))
    await reads(0)
    expect(another.result.current.txid).toBe(T)
    expect(another.navigation.replace).not.toHaveBeenCalled()
    another.unmount()

    const ordinary = renderSuccess({ txid: T }, completedView(T2, 3))
    await reads(0)
    expect(ordinary.result.current.txid).toBe(T)
    expect(ordinary.navigation.replace).not.toHaveBeenCalled()
  })

  it('reads no plan when opened for none, though the account has one open, as time passes and the plan changes; opened for one, it reads and follows it', async () => {
    vi.useFakeTimers()
    const open = planView({ phase: 'waiting', revision: 2 })
    const ordinary = renderSuccess({ txid: T }, open)
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId: 'plan-1', revision: 3 })
    })
    await reads(3)
    expect(ordinary.wallet.getQbitSendPlan).not.toHaveBeenCalled()
    expect(ordinary.result.current.txid).toBe(T)
    ordinary.unmount()
    await reads(0)
    expect(ordinary.wallet.dismissQbitSendPlan).not.toHaveBeenCalled()

    const ofPlan = renderSuccess({ txid: T, sendPlanId: 'plan-1' }, completedView(T, 3))
    await reads(0)
    expect(ofPlan.wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
    await reads()
    expect(ofPlan.wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
  })
})
