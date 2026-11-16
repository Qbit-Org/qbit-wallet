import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  BUS_METHODS,
  QBIT_SEND_PLAN_NOT_AS_SHOWN_CODE,
  type QbitSendPlanView,
} from '@qbit/wallet-shared'

import { I18nContext } from '../../src/context/I18nContext'
import { useQbitSendPlan } from '../../src/hooks/sendPlan'
import {
  useQbitSendPlanScreenLogic,
  type QbitSendPlanScreenLogic,
  type QbitSendPlanScreenReady,
} from '../../src/ui-hooks/useQbitSendPlanScreenLogic'
import { uiEventBus } from '../../src/utils/eventBus'
import { readQbitSendPlanView } from '../../src/utils/qbit-send-plan'
import { PLAN_RECIPIENT, deferred, planView } from './sendPlanFixtures'
import { createHookTestHarness } from './testHelpers'

// A page shows the plan the background stores, and Continue names the one
// it shows (#206, item 1). A view names the run of the background that made
// it (`backgroundId`): after the background starts again, what it stores
// may have been replaced, at any revision, so a view of another run replaces
// the one shown whatever its revision, and a change it announces is read.
// Within one run, nothing changes: a lower revision is stale. Continue
// carries the terms digest of the view shown; a refusal because the stored
// plan states other terms leads to a read of the plan and no second
// Continue.

const RUN_1 = '1'.repeat(32)
const RUN_2 = '2'.repeat(32)
const SHOWN_TERMS = 'a'.repeat(64)
const STORED_TERMS = 'b'.repeat(64)
const OTHER_RECIPIENT = 'qb1zother000000000000000000000000000000000000000000000000'

/** The plan as a page saw it before the background started again: paused, Continue offered. */
function shownBeforeRestart(overrides: Partial<QbitSendPlanView> = {}): QbitSendPlanView {
  return planView({
    phase: 'paused',
    pause: { reason: 'interrupted' },
    actions: ['continue', 'cancel'],
    signing: undefined,
    revision: 5_000_003,
    backgroundId: RUN_1,
    termsDigest: SHOWN_TERMS,
    ...overrides,
  })
}

/** What the background stores after it started again: another recipient, at a lower revision. */
function storedAfterRestart(overrides: Partial<QbitSendPlanView> = {}): QbitSendPlanView {
  return shownBeforeRestart({
    recipient: OTHER_RECIPIENT,
    revision: 2_000_000,
    backgroundId: RUN_2,
    termsDigest: STORED_TERMS,
    ...overrides,
  })
}

function renderPlan(harness = createHookTestHarness()) {
  const rendered = renderHook(() => useQbitSendPlan(), { wrapper: harness.wrapper })
  return { ...harness, ...rendered }
}

describe('useQbitSendPlan across a start of the background', () => {
  it('shows the view of a new run whatever its revision', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(shownBeforeRestart())
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.backgroundId).toBe(RUN_1))

    wallet.getQbitSendPlan.mockResolvedValueOnce(storedAfterRestart())
    await act(async () => result.current.refresh())
    await waitFor(() => expect(result.current.plan?.backgroundId).toBe(RUN_2))
    expect(result.current.plan).toMatchObject({
      recipient: OTHER_RECIPIENT,
      revision: 2_000_000,
      termsDigest: STORED_TERMS,
    })
  })

  it('reads a change a new run announces, whatever its revision', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(shownBeforeRestart())
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.backgroundId).toBe(RUN_1))

    // The same run's change already shown needs no read.
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, {
        planId: 'plan-1',
        revision: 5_000_003,
        backgroundId: RUN_1,
      })
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)

    wallet.getQbitSendPlan.mockResolvedValueOnce(storedAfterRestart())
    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, {
        planId: 'plan-1',
        revision: 2_000_000,
        backgroundId: RUN_2,
      })
    })
    await waitFor(() => expect(result.current.plan?.recipient).toBe(OTHER_RECIPIENT))
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
  })

  it('never lets an answer of the earlier run replace the new run’s view shown after it began', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(shownBeforeRestart())
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.backgroundId).toBe(RUN_1))

    // A call to the earlier run, answered last, with a higher revision.
    const call = deferred<QbitSendPlanView>()
    let applied: Promise<unknown> | undefined
    act(() => {
      applied = result.current.apply(
        () => call.promise,
        view => view
      )
    })
    wallet.getQbitSendPlan.mockResolvedValueOnce(storedAfterRestart())
    await act(async () => result.current.refresh())
    await waitFor(() => expect(result.current.plan?.backgroundId).toBe(RUN_2))

    await act(async () => {
      call.resolve(shownBeforeRestart({ revision: 5_000_009 }))
      await applied
    })
    expect(result.current.plan).toMatchObject({ backgroundId: RUN_2, recipient: OTHER_RECIPIENT })
  })

  it('still drops, within one run, a view older than the one shown and a change already shown', async () => {
    const harness = createHookTestHarness()
    harness.wallet.getQbitSendPlan.mockResolvedValueOnce(
      shownBeforeRestart({ revision: 5_000_003, signaturesDone: 50 })
    )
    const { result, wallet } = renderPlan(harness)
    await waitFor(() => expect(result.current.plan?.revision).toBe(5_000_003))

    wallet.getQbitSendPlan.mockResolvedValueOnce(
      shownBeforeRestart({ revision: 5_000_001, signaturesDone: 10 })
    )
    await act(async () => result.current.refresh())
    await waitFor(() => expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2))
    expect(result.current.plan).toMatchObject({ revision: 5_000_003, signaturesDone: 50 })

    await act(async () => {
      uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, {
        planId: 'plan-1',
        revision: 5_000_002,
        backgroundId: RUN_1,
      })
    })
    expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
  })

  it('keeps the terms digest and the run of a view it reads, and only of the form the background makes', () => {
    expect(readQbitSendPlanView(shownBeforeRestart())).toMatchObject({
      backgroundId: RUN_1,
      termsDigest: SHOWN_TERMS,
    })
    for (const termsDigest of [42, null, 'A'.repeat(64), 'a'.repeat(63), {}] as unknown[]) {
      const view = readQbitSendPlanView({ ...shownBeforeRestart(), termsDigest })
      expect(view).toBeDefined()
      expect(view).not.toHaveProperty('termsDigest')
    }
    for (const backgroundId of [42, null, '', {}] as unknown[]) {
      const view = readQbitSendPlanView({ ...shownBeforeRestart(), backgroundId })
      expect(view).toBeDefined()
      expect(view).not.toHaveProperty('backgroundId')
    }
  })
})

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

function clickContinue(logic: QbitSendPlanScreenLogic): void {
  const button = ready(logic).buttons.find(entry => entry.action === 'continue')
  if (!button) throw new Error('no continue button')
  button.onClick()
}

describe('useQbitSendPlanScreenLogic: Continue names the plan shown', () => {
  it('carries the terms digest of the view it shows', async () => {
    const { result, wallet } = await renderScreen(shownBeforeRestart())
    wallet.continueQbitSendPlan.mockResolvedValue(
      shownBeforeRestart({ phase: 'signing', pause: undefined, revision: 5_000_004 })
    )
    await act(async () => clickContinue(result.current))
    expect(wallet.continueQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.continueQbitSendPlan).toHaveBeenCalledWith('plan-1', SHOWN_TERMS)
  })

  it('reads the plan after a refusal, shows what is stored, says why, and does not continue again', async () => {
    const harness = createHookTestHarness()
    const { result, wallet } = await renderScreen(shownBeforeRestart(), harness)
    expect(ready(result.current)).toMatchObject({ recipient: PLAN_RECIPIENT })

    // The refusal as the UI port delivers it: a plain object.
    wallet.continueQbitSendPlan.mockRejectedValue({
      message: 'The Qbit send plan changed since it was shown: read it again before continuing',
      stack: 'at continue',
      code: QBIT_SEND_PLAN_NOT_AS_SHOWN_CODE,
    })
    wallet.getQbitSendPlan.mockResolvedValue(storedAfterRestart())
    const reads = wallet.getQbitSendPlan.mock.calls.length

    await act(async () => clickContinue(result.current))
    await waitFor(() => expect(ready(result.current).plan.backgroundId).toBe(RUN_2))
    expect(wallet.getQbitSendPlan.mock.calls.length).toBeGreaterThan(reads)
    expect(ready(result.current)).toMatchObject({
      recipient: OTHER_RECIPIENT,
      actionError: 'send_plan_not_as_shown',
      busy: null,
    })
    expect(ready(result.current).plan.termsDigest).toBe(STORED_TERMS)
    expect(ready(result.current).buttons.map(button => button.action)).toContain('continue')

    // Nothing continues by itself: the user decides on the stored figures.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    expect(wallet.continueQbitSendPlan).toHaveBeenCalledTimes(1)

    // The user's next Continue names what is shown now.
    wallet.continueQbitSendPlan.mockResolvedValue(
      storedAfterRestart({ phase: 'signing', pause: undefined, revision: 2_000_001 })
    )
    await act(async () => clickContinue(result.current))
    expect(wallet.continueQbitSendPlan).toHaveBeenCalledTimes(2)
    expect(wallet.continueQbitSendPlan).toHaveBeenLastCalledWith('plan-1', STORED_TERMS)
    expect(ready(result.current).actionError).toBe('')
  })

  it('shows any other failure as before', async () => {
    const { result, wallet } = await renderScreen(shownBeforeRestart())
    wallet.continueQbitSendPlan.mockRejectedValue({ message: 'The wallet is locked.' })
    await act(async () => clickContinue(result.current))
    expect(ready(result.current).actionError).toBe('The wallet is locked.')
  })
})
