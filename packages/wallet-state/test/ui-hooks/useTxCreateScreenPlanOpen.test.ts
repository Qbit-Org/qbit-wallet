import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import {
  BUS_METHODS,
  KeyringType,
  type QbitSendPlanPrepareResult,
  type QbitSendPlanView,
} from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { I18nContext } from '../../src/context/I18nContext'
import { accountActions } from '../../src/reducers/accounts'
import { settingsActions } from '../../src/reducers/settings'
import { transactionsActions } from '../../src/reducers/transactions'
import { uiActions } from '../../src/reducers/ui'
import { useTxCreateScreenLogic } from '../../src/ui-hooks/useTxCreateScreenLogic'
import { uiEventBus } from '../../src/utils/eventBus'
import { deferred, planReview, planView } from './sendPlanFixtures'
import { createHookTestHarness } from './testHelpers'

// The background answers Next `plan_open` while another page's start of a
// plan is under way for the account (#206). That start can end without
// storing a plan (`outputs_changed`, `draft_expired`, `locked`), and such an
// ending is announced to no page: the page learns of it only by reading the
// plan. A start that stores the plan announces it (`QBIT_SEND_PLAN_CHANGED`).

const RECIPIENT = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')

function p2mrAccount(pubkeyHex = '11'.repeat(32)) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const scriptPubKey = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript))
  return {
    type: KeyringType.QbitHdKeyring,
    address: p2mrAddressFromPubkey(pubkey, 'mainnet'),
    pubkey: pubkeyHex,
    key: `qbit-account-${pubkeyHex.slice(0, 2)}`,
    flag: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: "m/87'/0'/0'/0/0",
      scriptPubKey: bytesToHex(scriptPubKey),
      leafScript: bytesToHex(leafScript),
      addresses: {
        mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
        testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
        signet: p2mrAddressFromPubkey(pubkey, 'signet'),
        regtest: p2mrAddressFromPubkey(pubkey, 'regtest'),
      },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1073741824,
        remaining: 1073741824,
        state: 'normal' as const,
        provenance: 'local' as const,
      },
    },
  }
}

type Account = ReturnType<typeof p2mrAccount>

/**
 * 150 confirmed outputs of 10,000: one transaction of the 106 largest pays
 * at most 661,173, so 0.007 QBT needs a plan of one merge and the payment.
 */
function outputs(account: Account) {
  return Array.from(
    { length: 150 },
    (_unused, index) =>
      ({
        txid: (index + 1).toString(16).padStart(64, '0'),
        vout: 0,
        satoshis: 10_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      }) as any
  )
}

/**
 * The send screen at a Custom rate of 1 bit/vB, which settles at once, for
 * `account` holding `outputs(account)`, with t recording its substitutions.
 * The account has no send plan when the screen opens.
 */
function renderSend(account = p2mrAccount()) {
  const harness = createHookTestHarness()
  const utxos = outputs(account)
  harness.store.dispatch(
    (uiActions as any).updateFeeRateBar({ feeRate: 1, feeRateInputVal: '1', feeOptionIndex: 3 })
  )
  const total = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0)
  harness.wallet.getQbitUtxoSnapshot.mockResolvedValue({
    address: account.address,
    chain: ChainType.QBIT_MAINNET,
    utxos,
  })
  harness.store.dispatch((accountActions as any).setCurrent(account as any))
  harness.store.dispatch(
    (accountActions as any).setBalanceV2({
      address: account.address,
      balance: {
        availableBalance: total,
        unavailableBalance: 0,
        totalBalance: total,
        chainType: ChainType.QBIT_MAINNET,
      },
    })
  )
  harness.store.dispatch(
    (transactionsActions as any).setUtxos({
      address: account.address,
      chain: ChainType.QBIT_MAINNET,
      utxos,
    })
  )
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
      return useTxCreateScreenLogic()
    },
    { wrapper }
  )
  return { ...harness, ...rendered, account, renders: () => renders }
}

type Screen = { current: ReturnType<typeof useTxCreateScreenLogic> }

/** Fill the form with an amount only a plan can pay, and wait for its card. */
async function fill(result: Screen, amount = '0.00700000') {
  await waitFor(() => expect(result.current.availableAmount).not.toBe('--'))
  act(() => {
    result.current.onAddressInputChange({ address: RECIPIENT, domain: '' })
    result.current.onAmountInputChange(amount)
  })
  await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
  expect(result.current.disabled).toBe(false)
}

/** Let the answers already given land. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function planChanged(planId: string, revision: number) {
  await act(async () => {
    uiEventBus.emit(BUS_METHODS.QBIT_SEND_PLAN_CHANGED, { planId, revision })
  })
}

const PLAN_OPEN: QbitSendPlanPrepareResult = {
  ok: false,
  reason: 'plan_open',
  maxSendable: 0,
  unconfirmedSatoshis: 0,
}

/** The plan another page's start stored for `account`. */
function startedPlan(account: Account, overrides: Partial<QbitSendPlanView> = {}) {
  return planView({ address: account.address, ...overrides })
}

/** That plan once the network accepted its payment, not dismissed yet: not in progress. */
function completedPlan(account: Account) {
  return startedPlan(account, {
    phase: 'completed',
    sent: true,
    actions: ['dismiss'],
    signing: undefined,
    signaturesDone: 156,
    steps: [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'confirmed' },
      { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'broadcast' },
    ],
    revision: 9_000_000,
  })
}

/**
 * Next, answered `plan_open`: the plan read it asks for is the next one the
 * page makes, and is still on its way when this returns.
 */
async function nextAnsweredPlanOpen(screen: ReturnType<typeof renderSend>) {
  const read = deferred<QbitSendPlanView | null>()
  screen.wallet.getQbitSendPlan.mockReturnValueOnce(read.promise)
  screen.wallet.prepareQbitSendPlan.mockResolvedValueOnce(PLAN_OPEN)
  await act(async () => screen.result.current.onClickNext())
  // Next waits, says why, and links to the payment while the plan is read.
  expect(screen.result.current.sendPlanOpenText).toBe('send_plan_already_open')
  expect(screen.result.current.sendPlanNotice).toBeUndefined()
  expect(screen.result.current.disabled).toBe(true)
  return read
}

/** The form as the user left it, and Next working on it: a plan prepared for exactly that. */
async function expectNextWorksOnTheSameForm(screen: ReturnType<typeof renderSend>) {
  const { result, wallet, navigation } = screen
  expect(result.current.sendPlanOpenText).toBe('')
  expect(result.current.disabled).toBe(false)
  expect(result.current.error).toBe('')
  expect(result.current.sendPlanNotice?.receives).toBe('0.00700000 QBT')
  expect(result.current.toInfo.address).toBe(RECIPIENT)
  expect(result.current.inputAmount).toBe('0.00700000')

  const prepares = wallet.prepareQbitSendPlan.mock.calls.length
  const review = planReview()
  wallet.prepareQbitSendPlan.mockResolvedValueOnce({ ok: true, review })
  await act(async () => result.current.onClickNext())
  expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(prepares + 1)
  expect(wallet.prepareQbitSendPlan).toHaveBeenLastCalledWith({
    to: RECIPIENT,
    target: { kind: 'amount', amount: 700_000 },
    feeRate: 1,
    enableRBF: false,
  })
  expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanReviewScreen', { review })
}

describe('the send screen answered plan_open (#206)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each<[string, (account: Account) => QbitSendPlanView | null]>([
    // The other start ended without a plan.
    ['finds no plan', () => null],
    // The plan the answer named was done by the time the page read it.
    ['finds the plan completed', completedPlan],
  ])(
    'lets Next work again, with the form as it was, once the plan read after plan_open %s',
    async (_label, found) => {
      const screen = renderSend()
      await fill(screen.result)
      await settle()

      const read = await nextAnsweredPlanOpen(screen)
      expect(screen.wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
      await act(async () => read.resolve(found(screen.account)))

      await expectNextWorksOnTheSameForm(screen)
      // Nothing read the plan again for it.
      expect(screen.wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
    }
  )

  it('keeps the text and the link when the plan read after plan_open finds the plan', async () => {
    const screen = renderSend()
    const { result, wallet, navigation, account } = screen
    await fill(result)
    await settle()

    const read = await nextAnsweredPlanOpen(screen)
    await act(async () => read.resolve(startedPlan(account)))
    await settle()

    expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.disabled).toBe(true)
    act(() => result.current.onClickViewSendPlan())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it('names the payment again, with its link, when the start stores its plan after the read found none', async () => {
    const screen = renderSend()
    const { result, wallet, navigation, account } = screen
    await fill(result)
    await settle()

    const read = await nextAnsweredPlanOpen(screen)
    // The read was answered before the start stored its plan.
    await act(async () => read.resolve(null))
    expect(result.current.sendPlanOpenText).toBe('')
    expect(result.current.disabled).toBe(false)

    // The start stores the plan and announces it; the page reads it then.
    wallet.getQbitSendPlan.mockResolvedValue(startedPlan(account))
    await planChanged('plan-1', 1_000_000)
    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_already_open'))
    expect(result.current.disabled).toBe(true)
    expect(result.current.sendPlanNotice).toBeUndefined()
    act(() => result.current.onClickViewSendPlan())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it('lets Next work again once the read finds no plan, after replace-by-fee changed while it read', async () => {
    const screen = renderSend()
    const { result, wallet, navigation } = screen
    await fill(result)
    await settle()

    const read = await nextAnsweredPlanOpen(screen)
    // A choice the checks of the form do not depend on: only the read ends the wait.
    act(() => result.current.onRBFChange(true))
    await settle()
    expect(result.current.enableRBF).toBe(true)
    expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
    await act(async () => read.resolve(null))

    expect(result.current.sendPlanOpenText).toBe('')
    expect(result.current.disabled).toBe(false)
    expect(result.current.sendPlanNotice?.receives).toBe('0.00700000 QBT')
    const review = planReview()
    wallet.prepareQbitSendPlan.mockResolvedValueOnce({ ok: true, review })
    await act(async () => result.current.onClickNext())
    expect(wallet.prepareQbitSendPlan).toHaveBeenLastCalledWith({
      to: RECIPIENT,
      target: { kind: 'amount', amount: 700_000 },
      feeRate: 1,
      enableRBF: true,
    })
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanReviewScreen', { review })
  })

  it('lets Next work again when the plan read after plan_open fails', async () => {
    const screen = renderSend()
    await fill(screen.result)
    await settle()

    const read = await nextAnsweredPlanOpen(screen)
    // Nothing is known of the plan either way; the background answers Next afresh.
    await act(async () => read.reject({ message: 'port closed' }))

    await expectNextWorksOnTheSameForm(screen)
  })

  describe('answers that land out of order', () => {
    it('does not end the wait on a read that started before Next was answered', async () => {
      const screen = renderSend()
      const { result, wallet } = screen
      await fill(result)
      await settle()

      // A change of the plan is being read when Next is answered.
      const earlier = deferred<QbitSendPlanView | null>()
      wallet.getQbitSendPlan.mockReturnValueOnce(earlier.promise)
      await planChanged('plan-0', 1)
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
      const read = await nextAnsweredPlanOpen(screen)

      // That earlier read says nothing of the start Next was answered about.
      await act(async () => earlier.resolve(null))
      await settle()
      expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
      expect(result.current.disabled).toBe(true)

      await act(async () => read.resolve(null))
      await expectNextWorksOnTheSameForm(screen)
    })

    it('keeps no plan shown that an earlier read found after the later read found none', async () => {
      const screen = renderSend()
      const { result, wallet, account } = screen
      await fill(result)
      await settle()

      const earlier = deferred<QbitSendPlanView | null>()
      wallet.getQbitSendPlan.mockReturnValueOnce(earlier.promise)
      await planChanged('plan-0', 1)
      const read = await nextAnsweredPlanOpen(screen)

      // The read Next asked for lands first and finds none; the earlier one,
      // answered before the start ended, lands after it with the plan.
      await act(async () => read.resolve(null))
      expect(result.current.sendPlanOpenText).toBe('')
      await act(async () => earlier.resolve(startedPlan(account)))
      await settle()

      await expectNextWorksOnTheSameForm(screen)
    })

    it('keeps the payment named when the read Next asked for finds it and an earlier read that found none lands after it', async () => {
      const screen = renderSend()
      const { result, wallet, navigation, account } = screen
      await fill(result)
      await settle()

      const earlier = deferred<QbitSendPlanView | null>()
      wallet.getQbitSendPlan.mockReturnValueOnce(earlier.promise)
      await planChanged('plan-0', 1)
      const read = await nextAnsweredPlanOpen(screen)

      await act(async () => read.resolve(startedPlan(account)))
      await act(async () => earlier.resolve(null))
      await settle()

      expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
      expect(result.current.disabled).toBe(true)
      act(() => result.current.onClickViewSendPlan())
      expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
    })

    it("does not end a later Next's wait on the read an earlier Next asked for", async () => {
      const screen = renderSend()
      const { result } = screen
      await fill(result)
      await settle()

      const first = await nextAnsweredPlanOpen(screen)
      // Edits end the first wait and come back to the same form, for which
      // Next is answered plan_open again.
      act(() => result.current.onAmountInputChange('0.00800000'))
      await waitFor(() => expect(result.current.sendPlanNotice?.receives).toBe('0.00800000 QBT'))
      act(() => result.current.onAmountInputChange('0.00700000'))
      await waitFor(() => expect(result.current.sendPlanNotice?.receives).toBe('0.00700000 QBT'))
      expect(result.current.disabled).toBe(false)
      const second = await nextAnsweredPlanOpen(screen)

      await act(async () => first.resolve(null))
      await settle()
      expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
      expect(result.current.disabled).toBe(true)

      await act(async () => second.resolve(null))
      await expectNextWorksOnTheSameForm(screen)
    })

    it('drops a plan_open that lands after the amount changed: no wait, no read', async () => {
      const { result, wallet } = renderSend()
      await fill(result, '0.00800000')
      await settle()
      const answer = deferred<QbitSendPlanPrepareResult>()
      wallet.prepareQbitSendPlan.mockReturnValueOnce(answer.promise)

      act(() => result.current.onClickNext())
      act(() => result.current.onAmountInputChange('0.00700000'))
      await act(async () => answer.resolve(PLAN_OPEN))
      await settle()

      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(1)
      expect(result.current.sendPlanOpenText).toBe('')
      await waitFor(() => expect(result.current.sendPlanNotice?.receives).toBe('0.00700000 QBT'))
      expect(result.current.disabled).toBe(false)
    })
  })

  describe('while the plan read after plan_open is on its way', () => {
    it('reads nothing more and leaves no timer once the screen is gone', async () => {
      const screen = renderSend()
      const { wallet, unmount } = screen
      await fill(screen.result)
      await settle()
      const read = await nextAnsweredPlanOpen(screen)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        vi.useFakeTimers()
        unmount()
        await act(async () => read.resolve(null))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000)
        })

        expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2)
        expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
        expect(errors).not.toHaveBeenCalled()
      } finally {
        errors.mockRestore()
      }
    })

    it('shows nothing of the earlier account once another is selected, and reads only for the new one', async () => {
      const screen = renderSend()
      const { result, wallet, store, account } = screen
      await fill(result)
      await settle()
      const read = await nextAnsweredPlanOpen(screen)

      const other = p2mrAccount('22'.repeat(32))
      await act(async () => {
        store.dispatch((accountActions as any).setCurrent(other as any))
      })
      await settle()
      // The new account's own read, and no other.
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)
      expect(result.current.sendPlanOpenText).toBe('')

      // The earlier account's answer lands late, naming its plan: it reads
      // nothing more and updates nothing.
      const renders = screen.renders()
      await act(async () => read.resolve(startedPlan(account)))
      await settle()
      expect(screen.renders()).toBe(renders)
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)
      expect(result.current.sendPlanOpenText).toBe('')
      expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
    })

    it('shows nothing of the earlier network once another is selected, and reads only for the new one', async () => {
      const screen = renderSend()
      const { result, wallet, store, account } = screen
      await fill(result)
      await settle()
      const read = await nextAnsweredPlanOpen(screen)

      await act(async () => {
        store.dispatch(
          (settingsActions as any).updateSettings({ chainType: ChainType.QBIT_TESTNET4 })
        )
      })
      await settle()
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)
      expect(result.current.sendPlanOpenText).toBe('')

      const renders = screen.renders()
      await act(async () => read.resolve(startedPlan(account)))
      await settle()
      expect(screen.renders()).toBe(renders)
      expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(3)
      expect(result.current.sendPlanOpenText).toBe('')
      expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
    })
  })
})
