import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type QbitSendPlanView } from '@qbit/wallet-shared'

import { I18nContext } from '../../src/context/I18nContext'
import { QBIT_SEND_PLAN_POLL_MS, useQbitSendPlan } from '../../src/hooks/sendPlan'
import { useQbitSendPlanEntryLogic } from '../../src/ui-hooks/useQbitSendPlanEntryLogic'
import { planView } from './sendPlanFixtures'
import { createHookTestHarness } from './testHelpers'

// A completed send plan is not final while the transaction it names has
// not confirmed (#217): the background may name the transaction that
// replaced it, or reopen the plan as paused. A page showing the completed
// plan follows it as it follows an open one, with or without the change
// events, and stops reading only once that transaction has confirmed.

const T = '11'.repeat(32)
const T2 = '22'.repeat(32)

/** The plan completed, naming `txid` as its payment, `status` as that transaction stands. */
function completedView(
  txid: string,
  status: 'broadcast' | 'confirmed',
  revision: number
): QbitSendPlanView {
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
      { kind: 'payment', txid, inputCount: 50, fee: 3_000, status },
    ],
  })
}

/** The plan reopened as paused, its payment to be sent again, which may still go through. */
function reopenedView(revision: number): QbitSendPlanView {
  return planView({
    phase: 'paused',
    pause: { reason: 'interrupted' },
    revision,
    actions: ['continue'],
    signing: undefined,
    sent: true,
    paymentMayConfirm: true,
    steps: [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'confirmed' },
      { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'planned' },
    ],
  })
}

/** Time passes for the page's poll, and its reads land. */
async function poll(times = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(QBIT_SEND_PLAN_POLL_MS * times)
  })
}

function keysI18n(baseWrapper: ({ children }: { children: ReactNode }) => any) {
  const t = (key: string, substitutions?: string | string[]): string =>
    substitutions === undefined
      ? key
      : `${key}:${(Array.isArray(substitutions) ? substitutions : [substitutions]).join(',')}`
  return ({ children }: { children: ReactNode }) =>
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
}

describe('a page showing a completed plan whose payment has not confirmed', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads it on, shows the transaction that replaced the one it named, and stops once that has confirmed', async () => {
    vi.useFakeTimers()
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(completedView(T, 'broadcast', 3))
    const { result } = renderHook(() => useQbitSendPlan(), { wrapper: harness.wrapper })
    await poll(0)
    expect(result.current.plan).toMatchObject({ phase: 'completed', paymentTxid: T })
    expect(harness.wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)

    // No change event reaches the page: its own reads find the switch.
    harness.wallet.getQbitSendPlan.mockResolvedValue(completedView(T2, 'broadcast', 4))
    await poll()
    expect(harness.wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
    expect(result.current.plan).toMatchObject({ phase: 'completed', paymentTxid: T2 })

    harness.wallet.getQbitSendPlan.mockResolvedValue(completedView(T2, 'confirmed', 5))
    await poll()
    expect(result.current.plan?.steps.at(-1)).toMatchObject({ txid: T2, status: 'confirmed' })
    const reads = harness.wallet.getQbitSendPlan.mock.calls.length
    await poll(3)
    expect(harness.wallet.getQbitSendPlan).toHaveBeenCalledTimes(reads)
  })

  it('shows the plan reopened as paused, read without any change event', async () => {
    vi.useFakeTimers()
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(completedView(T, 'broadcast', 3))
    const { result } = renderHook(() => useQbitSendPlan(), { wrapper: harness.wrapper })
    await poll(0)
    expect(result.current.plan?.phase).toBe('completed')

    harness.wallet.getQbitSendPlan.mockResolvedValue(reopenedView(4))
    await poll()
    expect(result.current.plan).toMatchObject({
      phase: 'paused',
      pause: { reason: 'interrupted' },
      paymentMayConfirm: true,
      actions: ['continue'],
    })
    // Reopened, it is followed as any open plan.
    await poll()
    expect(harness.wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)
  })

  it('on the home card: opens the success screen for the transaction named now, and once reopened says it needs the user and opens the progress screen', async () => {
    vi.useFakeTimers()
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValue(completedView(T, 'broadcast', 3))
    const { result } = renderHook(() => useQbitSendPlanEntryLogic(), {
      wrapper: keysI18n(harness.wrapper),
    })
    await poll(0)
    expect(result.current).toMatchObject({ tone: 'sent' })
    act(() => result.current?.onClickOpen())
    expect(harness.navigation.navigate).toHaveBeenLastCalledWith('TxSuccessScreen', {
      txid: T,
      sendPlanId: 'plan-1',
    })

    harness.wallet.getQbitSendPlan.mockResolvedValue(completedView(T2, 'broadcast', 4))
    await poll()
    act(() => result.current?.onClickOpen())
    expect(harness.navigation.navigate).toHaveBeenLastCalledWith('TxSuccessScreen', {
      txid: T2,
      sendPlanId: 'plan-1',
    })

    harness.wallet.getQbitSendPlan.mockResolvedValue(reopenedView(5))
    await poll()
    expect(result.current).toMatchObject({
      title: 'send_plan_home_paused:0.01000000,QBT',
      status: 'send_plan_status_may_confirm',
      tone: 'paused',
    })
    act(() => result.current?.onClickOpen())
    expect(harness.navigation.navigate).toHaveBeenLastCalledWith('QbitSendPlanScreen')
  })
})
