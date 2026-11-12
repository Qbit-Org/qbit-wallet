import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
import {
  estimateQbitP2mrSendAllPreflight,
  planQbitP2mrSendPreflight,
  usePrepareSendQBTCallback,
} from '../../src/hooks/transactions'
import { accountActions } from '../../src/reducers/accounts'
import { transactionsActions } from '../../src/reducers/transactions'
import { uiActions } from '../../src/reducers/ui'
import { useTxCreateScreenLogic } from '../../src/ui-hooks/useTxCreateScreenLogic'
import { uiEventBus } from '../../src/utils/eventBus'
import { deferred, planReview, planView, unreadablePlanView } from './sendPlanFixtures'
import { createHookTestHarness } from './testHelpers'

const RECIPIENT = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')

function p2mrAccount(pubkeyHex = '11'.repeat(32)) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const scriptPubKey = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript))
  return {
    type: KeyringType.QbitHdKeyring,
    address: p2mrAddressFromPubkey(pubkey, 'mainnet'),
    pubkey: pubkeyHex,
    key: 'qbit-account-1',
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

function outputs(account: Account, values: number[], first = 1) {
  return values.map(
    (satoshis, index) =>
      ({
        txid: (index + first).toString(16).padStart(64, '0'),
        vout: 0,
        satoshis,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      }) as any
  )
}

/** Unconfirmed change of the account's own, with its readable ancestry. */
function unconfirmedChange(account: Account, satoshis: number) {
  const txid = 'ee'.repeat(32)
  return {
    ...outputs(account, [satoshis])[0],
    txid,
    vout: 1,
    unconfirmed: true,
    unconfirmedAncestors: [{ txid, vsize: 4_000 }],
  }
}

/**
 * The send screen at a Custom rate of 1 bit/vB, which settles at once, for
 * a P2MR account holding `utxos`, with t recording its substitutions. The
 * background answers `plan` for the account's send plan: none by default.
 */
function renderSend(utxos: any[], account = p2mrAccount(), plan: QbitSendPlanView | null = null) {
  const harness = createHookTestHarness()
  harness.wallet.getQbitSendPlan.mockResolvedValue(plan)
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
  const rendered = renderHook(() => useTxCreateScreenLogic(), { wrapper })
  return { ...harness, ...rendered, account, wrapper }
}

async function enter(
  result: { current: ReturnType<typeof useTxCreateScreenLogic> },
  amount?: string
) {
  await waitFor(() => expect(result.current.availableAmount).not.toBe('--'))
  act(() => {
    result.current.onAddressInputChange({ address: RECIPIENT, domain: '' })
    if (amount === undefined) result.current.onAmountMaxClick()
    else result.current.onAmountInputChange(amount)
  })
}

describe('the send screen with a payment one transaction cannot carry (#188)', () => {
  it('prices an amount that needs more than 106 outputs as a plan, with no error', async () => {
    const { result } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result, '0.00700000')

    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    expect(result.current.sendPlanNotice).toEqual({
      title: 'send_plan_notice_title:2',
      steps: 'send_plan_steps_one',
      receives: '0.00700000 QBT',
      // One merge of 106 outputs (398,827) and the payment (31,173).
      totalFee: '0.00430000 QBT',
      // 114 signatures and 2 transactions: 149 seconds.
      signing: 'send_plan_signatures:114 · send_plan_time_minutes:2',
      leftBehind: '',
      unconfirmed: '',
    })
    expect(result.current.error).toBe('')
    expect(result.current.disabled).toBe(false)
    expect(result.current.sendPlanRefusal).toBeUndefined()
    // The card carries the fee: no estimate of a single transaction.
    expect(result.current.feeDetail).toBeUndefined()
    // What leaves the wallet: the amount and every fee of the plan.
    expect(result.current.spendSummary?.totalSpend).toBe('0.01130000')
  })

  it('sends the whole balance with MAX, the exact amount shown', async () => {
    const { result } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result)

    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    expect(result.current.inputAmount).toBe('0.01500000')
    expect(result.current.sendPlanNotice).toMatchObject({
      title: 'send_plan_notice_title_everything:2',
      // 1,500,000 less the merge's 398,827 and the payment's 169,345.
      receives: '0.00931828 QBT',
      totalFee: '0.00568172 QBT',
      leftBehind: '',
    })
    expect(result.current.leftBehindNote).toBeUndefined()
    expect(result.current.disabled).toBe(false)
  })

  it('says what stays behind when MAX sends the whole balance', async () => {
    const account = p2mrAccount()
    // Outputs worth less than their own fee stay; change not confirmed yet
    // is not included either, and the card says so on its own line.
    const utxos = [
      ...outputs(account, Array(150).fill(10_000)),
      ...outputs(account, [3_000, 3_000], 500),
      unconfirmedChange(account, 50_000),
    ]
    const { result } = renderSend(utxos, account)
    await enter(result)

    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    expect(result.current.sendPlanNotice).toMatchObject({
      leftBehind: 'send_plan_left_behind:0.00006000,QBT',
      unconfirmed: 'send_plan_unconfirmed_not_included:0.00050000,QBT',
    })
  })

  it('keeps the one-transaction MAX, and its note, when combining the rest gives the recipient nothing more', async () => {
    const account = p2mrAccount()
    const { result } = renderSend(
      outputs(account, [...Array(44).fill(3_000), ...Array(106).fill(20_000)]),
      account
    )
    await enter(result)

    await waitFor(() => expect(result.current.disabled).toBe(false))
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.feeDetail).toMatchObject({ inputCount: 106, leftBehindInputCount: 44 })
    expect(result.current.leftBehindNote).toBe(
      'send_all_leaves_outputs_behind:106,0.00132000,QBT,44'
    )
  })

  describe('MAX sends the most the wallet can send now (#188)', () => {
    it('sends one transaction when it pays the recipient more than a plan of the confirmed funds', async () => {
      const account = p2mrAccount()
      // A plan spends confirmed outputs only; one transaction of the 106
      // largest also spends the large change not confirmed yet.
      const utxos = [
        ...outputs(account, Array(300).fill(100_000)),
        unconfirmedChange(account, 1_000_000_000),
      ]
      const shape = { utxos, account: account as any, feeRate: 1 }
      // 10 QBT and 105 outputs of 0.001, less the 398,827 fee of 106 inputs.
      expect(estimateQbitP2mrSendAllPreflight(shape).outputSatoshis).toBe(1_010_101_173)
      // Two merges, then a payment of 90 inputs, of the 300 confirmed outputs.
      const plan = planQbitP2mrSendPreflight({ ...shape, target: { kind: 'everything' } })
      expect(plan).toMatchObject({ merges: [{}, {}], payment: { amount: 28_863_711 } })

      const { result, wallet, navigation } = renderSend(utxos, account)
      await enter(result)

      await waitFor(() => expect(result.current.disabled).toBe(false))
      expect(result.current.sendPlanNotice).toBeUndefined()
      expect(result.current.sendPlanRefusal).toBeUndefined()
      expect(result.current.feeDetail).toMatchObject({
        inputCount: 106,
        estimatedFee: 398_827,
        leftBehindInputCount: 195,
        leftBehindSats: 19_500_000,
      })
      expect(result.current.leftBehindNote).toBe(
        'send_all_leaves_outputs_behind:106,0.19500000,QBT,195'
      )
      // What leaves the wallet: the 10.10101173 the recipient receives and the fee.
      expect(result.current.spendSummary?.totalSpend).toBe('10.10500000')

      // Next builds that one transaction, from the outputs the preview priced.
      const toSignData = { psbtHex: 'aa' }
      wallet.createSendAllQbitPsbt.mockResolvedValue(toSignData)
      await act(async () => result.current.onClickNext())
      expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
      expect(wallet.createSendAllQbitPsbt).toHaveBeenCalledTimes(1)
      expect(wallet.createSendAllQbitPsbt.mock.calls[0]?.[0]).toMatchObject({
        to: RECIPIENT,
        feeRate: 1,
        qbitUtxos: utxos,
      })
      expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData })
    })

    it('sends one transaction when it pays exactly what the plan would, since it needs no waiting', async () => {
      const account = p2mrAccount()
      // 280,655 and 105 outputs of 10,000, less 398,827: 931,828, what the
      // plan of the 150 confirmed outputs pays.
      const utxos = [
        ...outputs(account, Array(150).fill(10_000)),
        unconfirmedChange(account, 280_655),
      ]
      const { result } = renderSend(utxos, account)
      await enter(result)

      await waitFor(() => expect(result.current.disabled).toBe(false))
      expect(result.current.sendPlanNotice).toBeUndefined()
      expect(result.current.leftBehindNote).toBe(
        'send_all_leaves_outputs_behind:106,0.00450000,QBT,45'
      )
      expect(result.current.spendSummary?.totalSpend).toBe('0.01330655')
    })

    it.each([
      // One transaction of the 106 largest pays 701,173.
      [50_000, '0.00050000'],
      // It pays 931,827: one bit less than the plan is enough.
      [280_654, '0.00280654'],
    ])(
      'sends the plan when it pays the recipient more (change of %i not confirmed yet), and says that change is not included',
      async (change, changeAmount) => {
        const account = p2mrAccount()
        const { result } = renderSend(
          [...outputs(account, Array(150).fill(10_000)), unconfirmedChange(account, change)],
          account
        )
        await enter(result)

        await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
        expect(result.current.sendPlanNotice).toMatchObject({
          title: 'send_plan_notice_title_everything:2',
          receives: '0.00931828 QBT',
          leftBehind: '',
          unconfirmed: `send_plan_unconfirmed_not_included:${changeAmount},QBT`,
        })
        expect(result.current.leftBehindNote).toBeUndefined()
        expect(result.current.feeDetail).toBeUndefined()
        // The plan spends the 150 confirmed outputs, every bit of them.
        expect(result.current.spendSummary?.totalSpend).toBe('0.01500000')
      }
    )

    it('says nothing of funds not confirmed yet when there are none', async () => {
      const { result } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
      await enter(result)

      await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
      expect(result.current.sendPlanNotice?.unconfirmed).toBe('')
    })

    it('sends the whole balance read again as one transaction when the background needs no plan', async () => {
      const account = p2mrAccount()
      const { result, wallet, navigation } = renderSend(
        outputs(account, Array(150).fill(10_000)),
        account
      )
      await enter(result)
      await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())

      // The background read the account afresh: what it holds now fits one transaction.
      const fresh = outputs(account, Array(100).fill(15_000), 900)
      wallet.getQbitUtxoSnapshot.mockResolvedValue({
        address: account.address,
        chain: ChainType.QBIT_MAINNET,
        utxos: fresh,
      })
      wallet.prepareQbitSendPlan.mockResolvedValue({
        ok: false,
        reason: 'not_needed',
        maxSendable: 0,
        unconfirmedSatoshis: 0,
      })
      const toSignData = { psbtHex: 'aa' }
      wallet.createSendAllQbitPsbt.mockResolvedValue(toSignData)

      await act(async () => result.current.onClickNext())
      await waitFor(() =>
        expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData })
      )
      expect(wallet.prepareQbitSendPlan.mock.calls[0]?.[0]).toMatchObject({
        target: { kind: 'everything' },
      })
      expect(wallet.createSendAllQbitPsbt).toHaveBeenCalledTimes(1)
      expect(wallet.createSendAllQbitPsbt.mock.calls[0]?.[0]).toMatchObject({
        to: RECIPIENT,
        feeRate: 1,
        qbitUtxos: fresh,
      })
      expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
    })
  })

  it('leaves an amount one transaction carries as the ordinary send', async () => {
    const { result, wallet } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result, '0.00300000')

    await waitFor(() => expect(result.current.disabled).toBe(false))
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.feeDetail?.inputCount).toBeGreaterThan(0)

    wallet.createSendQbitPsbt.mockResolvedValue({ psbtHex: '00' })
    await act(async () => result.current.onClickNext())
    expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
    expect(wallet.createSendQbitPsbt).toHaveBeenCalledTimes(1)
  })

  it('says the balance does not cover the fees and offers the largest amount to choose', async () => {
    const { result, wallet } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result, '0.01400000')

    await waitFor(() => expect(result.current.sendPlanRefusal).toBeDefined())
    expect(result.current.sendPlanRefusal).toEqual({
      message: 'send_plan_short_of_fees',
      offerText: 'send_plan_max_sendable:0.00931828,QBT',
      offerButtonText: 'send_plan_use_max_sendable:0.00931828,QBT',
      unconfirmedText: '',
    })
    expect(result.current.disabled).toBe(true)
    expect(result.current.error).toBe('')
    // The amount typed stays until the user chooses another.
    expect(result.current.inputAmount).toBe('0.01400000')

    act(() => result.current.onClickMaxSendable())
    expect(result.current.inputAmount).toBe('0.00931828')
    await waitFor(() => expect(result.current.sendPlanNotice?.receives).toBe('0.00931828 QBT'))
    expect(result.current.sendPlanRefusal).toBeUndefined()
    expect(result.current.disabled).toBe(false)
    expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
  })

  it('mentions funds not confirmed yet that the offer leaves out', async () => {
    const account = p2mrAccount()
    const { result } = renderSend(
      [...outputs(account, Array(150).fill(10_000)), unconfirmedChange(account, 8_000)],
      account
    )
    await enter(result, '0.01400000')

    await waitFor(() => expect(result.current.sendPlanRefusal).toBeDefined())
    expect(result.current.sendPlanRefusal).toMatchObject({
      offerText: 'send_plan_max_sendable:0.00931828,QBT',
      unconfirmedText: 'send_plan_unconfirmed_note:0.00008000,QBT',
    })
  })

  it('offers what one transaction of the largest outputs sends when that is more', async () => {
    const account = p2mrAccount()
    // A large change not confirmed yet: a plan cannot spend it, one transaction can.
    const { result } = renderSend(
      [...outputs(account, Array(110).fill(10_000)), unconfirmedChange(account, 2_000_000)],
      account
    )
    await enter(result, '0.03090000')

    await waitFor(() => expect(result.current.sendPlanRefusal).toBeDefined())
    // 2,000,000 and 105 outputs of 10,000, less the 398,827 fee of 106 inputs.
    expect(result.current.sendPlanRefusal).toMatchObject({
      offerText: 'send_plan_max_sendable:0.02651173,QBT',
      unconfirmedText: '',
    })
  })

  it('keeps the ordinary refusal for an amount above the balance', async () => {
    const { result } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result, '0.02000000')
    await waitFor(() => expect(result.current.error).toBe('amount_exceeds_your_available_balance'))
    expect(result.current.sendPlanRefusal).toBeUndefined()
  })

  it('prepares the plan once with exactly what the screen shows, then opens its review', async () => {
    const { result, wallet, navigation, tools } = renderSend(
      outputs(p2mrAccount(), Array(150).fill(10_000))
    )
    await enter(result, '0.00700000')
    act(() => {
      result.current.onMemoChange('rent')
    })
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())

    const review = planReview()
    const answer = deferred<QbitSendPlanPrepareResult>()
    wallet.prepareQbitSendPlan.mockReturnValue(answer.promise)
    act(() => {
      result.current.onClickNext()
      result.current.onClickNext()
    })
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledWith({
      to: RECIPIENT,
      target: { kind: 'amount', amount: 700_000 },
      feeRate: 1,
      enableRBF: false,
      memo: 'rent',
    })
    expect(result.current.disabled).toBe(true)

    await act(async () => answer.resolve({ ok: true, review }))
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanReviewScreen', { review })
    expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
    expect(tools.showLoading).toHaveBeenLastCalledWith(false)
  })

  it('asks for the whole balance with MAX', async () => {
    const { result, wallet } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result)
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    wallet.prepareQbitSendPlan.mockResolvedValue({ ok: true, review: planReview() })

    await act(async () => result.current.onClickNext())
    expect(wallet.prepareQbitSendPlan.mock.calls[0]?.[0]).toEqual({
      to: RECIPIENT,
      target: { kind: 'everything' },
      feeRate: 1,
      enableRBF: false,
    })
  })

  it('sends the payment as one transaction from outputs read again when the plan is not needed', async () => {
    const account = p2mrAccount()
    const { result, wallet, navigation } = renderSend(
      outputs(account, Array(150).fill(10_000)),
      account
    )
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())

    // The background read the account afresh: a payment arrived that covers it.
    const fresh = [
      ...outputs(account, Array(150).fill(10_000)),
      ...outputs(account, [2_000_000], 900),
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({
      address: account.address,
      chain: ChainType.QBIT_MAINNET,
      utxos: fresh,
    })
    wallet.prepareQbitSendPlan.mockResolvedValue({
      ok: false,
      reason: 'not_needed',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
    })
    const toSignData = { psbtHex: 'aa' }
    wallet.createSendQbitPsbt.mockResolvedValue(toSignData)

    await act(async () => result.current.onClickNext())
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData })
    )
    expect(wallet.createSendQbitPsbt).toHaveBeenCalledTimes(1)
    expect(wallet.createSendQbitPsbt.mock.calls[0]?.[0]).toMatchObject({
      to: RECIPIENT,
      amount: 700_000,
      feeRate: 1,
      qbitUtxos: fresh,
      qbitUtxoAddress: account.address,
      qbitUtxoChain: ChainType.QBIT_MAINNET,
    })
    expect(navigation.navigate).not.toHaveBeenCalledWith(
      'QbitSendPlanReviewScreen',
      expect.anything()
    )
  })

  it('links to the payment already in progress', async () => {
    const { result, wallet, navigation } = renderSend(
      outputs(p2mrAccount(), Array(150).fill(10_000))
    )
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    wallet.prepareQbitSendPlan.mockResolvedValue({
      ok: false,
      reason: 'plan_open',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
    })

    await act(async () => result.current.onClickNext())
    expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.disabled).toBe(true)
    act(() => result.current.onClickViewSendPlan())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
  })

  it("shows the background's refusal with its offer, which the user can choose", async () => {
    const { result, wallet } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    wallet.prepareQbitSendPlan.mockResolvedValue({
      ok: false,
      reason: 'exceeds_plan_size',
      maxSendable: 650_000,
      unconfirmedSatoshis: 12_000,
    })

    await act(async () => result.current.onClickNext())
    expect(result.current.sendPlanRefusal).toEqual({
      message: 'send_plan_exceeds_plan_size',
      offerText: 'send_plan_max_sendable:0.00650000,QBT',
      offerButtonText: 'send_plan_use_max_sendable:0.00650000,QBT',
      unconfirmedText: 'send_plan_unconfirmed_note:0.00012000,QBT',
    })
    expect(result.current.disabled).toBe(true)
    act(() => result.current.onClickMaxSendable())
    expect(result.current.inputAmount).toBe('0.00650000')
  })

  it("says when the account's funds could not be read, and lets Next try again", async () => {
    const { result, wallet } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    wallet.prepareQbitSendPlan.mockResolvedValueOnce({
      ok: false,
      reason: 'outputs_unavailable',
      maxSendable: 0,
      unconfirmedSatoshis: 0,
    })

    await act(async () => result.current.onClickNext())
    expect(result.current.error).toBe('send_plan_outputs_unavailable')
    expect(result.current.disabled).toBe(false)
  })

  it('shows the message of a prepare that failed', async () => {
    const { result, wallet, navigation } = renderSend(
      outputs(p2mrAccount(), Array(150).fill(10_000))
    )
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    wallet.prepareQbitSendPlan.mockRejectedValueOnce({
      message: 'feeRate must be between 0.25 and 10000 bits/vB',
    })

    await act(async () => result.current.onClickNext())
    expect(result.current.error).toBe('feeRate must be between 0.25 and 10000 bits/vB')
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('drops an answer that lands after the amount changed', async () => {
    const { result, wallet, navigation } = renderSend(
      outputs(p2mrAccount(), Array(150).fill(10_000))
    )
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    const answer = deferred<QbitSendPlanPrepareResult>()
    wallet.prepareQbitSendPlan.mockReturnValue(answer.promise)

    act(() => result.current.onClickNext())
    act(() => result.current.onAmountInputChange('0.00800000'))
    await act(async () => answer.resolve({ ok: true, review: planReview() }))
    expect(navigation.navigate).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.sendPlanNotice?.receives).toBe('0.00800000 QBT'))
  })

  it.each([
    ['still being typed', { feeRate: 0, feeRateInputVal: '' }],
    ['below the floor', { feeRate: 0.1, feeRateInputVal: '0.1' }],
    ['above the ceiling', { feeRate: 20_000, feeRateInputVal: '20000' }],
    ['not a number', { feeRate: Number.NaN, feeRateInputVal: '1' }],
  ])('neither plans nor prepares at a rate %s', async (_label, rate) => {
    const { result, wallet, store } = renderSend(outputs(p2mrAccount(), Array(150).fill(10_000)))
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())

    act(() => {
      store.dispatch((uiActions as any).updateFeeRateBar(rate))
    })
    await waitFor(() => expect(result.current.sendPlanNotice).toBeUndefined())
    expect(result.current.disabled).toBe(true)
    await act(async () => result.current.onClickNext())
    expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
  })

  it('refuses to build one transaction for an amount only a plan can pay', async () => {
    const account = p2mrAccount()
    const { wallet, wrapper } = renderSend(outputs(account, Array(150).fill(10_000)), account)
    const { result: prepare } = renderHook(() => usePrepareSendQBTCallback(), { wrapper })

    await expect(
      prepare.current({ toAddressInfo: { address: RECIPIENT }, toAmount: 700_000, feeRate: 1 })
    ).rejects.toThrow('send_plan_outputs_changed')
    expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
  })
})

/** The account's plan in progress, as the background shows it. */
function openPlan(account: Account, overrides: Partial<QbitSendPlanView> = {}): QbitSendPlanView {
  return planView({ address: account.address, ...overrides })
}

/** The account's plan once the network accepted its payment, not dismissed yet. */
function completedPlan(account: Account): QbitSendPlanView {
  return planView({
    address: account.address,
    phase: 'completed',
    sent: true,
    actions: ['dismiss'],
    signing: undefined,
    signaturesDone: 156,
    steps: [
      { kind: 'merge', txid: 'aa'.repeat(32), inputCount: 106, fee: 398_827, status: 'confirmed' },
      { kind: 'payment', txid: 'bb'.repeat(32), inputCount: 50, fee: 190_000, status: 'broadcast' },
    ],
    revision: 9,
  })
}

/** Let the answers already given (the plan's read, the outputs' read) land. */
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

const PLAN_OPEN_ANSWER: QbitSendPlanPrepareResult = {
  ok: false,
  reason: 'plan_open',
  maxSendable: 0,
  unconfirmedSatoshis: 0,
}

describe('the send screen while another payment of the account is in progress (#188)', () => {
  // 150 outputs of 10,000 the payment in progress does not hold (the
  // background leaves the ones it holds out of every read). One transaction
  // of the 106 largest pays 661,173: 1,060,000 less the 398,827 fee of 106
  // inputs. A plan of all 150 would pay 931,828, but the background starts
  // no second plan for the account.
  const free = (account: Account) => outputs(account, Array(150).fill(10_000))

  it('sends one transaction of the free outputs with MAX, says what stays, and links to the payment', async () => {
    const account = p2mrAccount()
    const utxos = free(account)
    const { result, wallet, navigation } = renderSend(utxos, account, openPlan(account))
    await enter(result)

    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_open_holds_rest'))
    expect(result.current.disabled).toBe(false)
    expect(result.current.error).toBe('')
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.sendPlanRefusal).toBeUndefined()
    expect(result.current.feeDetail).toMatchObject({
      inputCount: 106,
      estimatedFee: 398_827,
      leftBehindInputCount: 44,
      leftBehindSats: 440_000,
    })
    expect(result.current.leftBehindNote).toBe(
      'send_all_leaves_outputs_behind:106,0.00440000,QBT,44'
    )
    // What leaves the wallet: the 661,173 the recipient receives and the fee.
    expect(result.current.spendSummary?.totalSpend).toBe('0.01060000')
    // Read once: that read already left out what the plan holds.
    await settle()
    expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(1)

    act(() => result.current.onClickViewSendPlan())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')

    const toSignData = { psbtHex: 'aa' }
    wallet.createSendAllQbitPsbt.mockResolvedValue(toSignData)
    await act(async () => result.current.onClickNext())
    expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
    expect(wallet.createSendAllQbitPsbt).toHaveBeenCalledTimes(1)
    expect(wallet.createSendAllQbitPsbt.mock.calls[0]?.[0]).toMatchObject({
      to: RECIPIENT,
      feeRate: 1,
      qbitUtxos: utxos,
    })
    expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData })
  })

  it('says a payment is in progress for an amount only a plan can pay, links to it, and waits only for it', async () => {
    const account = p2mrAccount()
    const { result, wallet, navigation } = renderSend(free(account), account, openPlan(account))
    await enter(result, '0.00700000')

    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_already_open'))
    expect(result.current.disabled).toBe(true)
    // Nothing else holds Next back.
    expect(result.current.error).toBe('')
    expect(result.current.sendPlanRefusal).toBeUndefined()
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.feeDetail).toBeUndefined()
    expect(result.current.leftBehindNote).toBeUndefined()
    expect(result.current.spendSummary).toBeUndefined()
    act(() => result.current.onClickViewSendPlan())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
    expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()

    // Once the network accepted that payment, this one is priced as a plan
    // again, from outputs read again: a finished plan holds nothing.
    wallet.getQbitSendPlan.mockResolvedValue(completedPlan(account))
    await planChanged('plan-1', 9)
    await waitFor(() => expect(result.current.sendPlanNotice?.receives).toBe('0.00700000 QBT'))
    expect(result.current.sendPlanOpenText).toBe('')
    expect(result.current.disabled).toBe(false)
    await waitFor(() => expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(2))
  })

  it.each<[string, Partial<QbitSendPlanView>]>([
    ['paused', { phase: 'paused', pause: { reason: 'merge_refused' }, actions: ['replan', 'cancel'] }],
    ['cancelling', { phase: 'cancelling', actions: [] }],
  ])('counts a plan %s as in progress', async (_label, overrides) => {
    const account = p2mrAccount()
    const plan = openPlan(account, overrides)
    const { result } = renderSend(free(account), account, plan)
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_already_open'))
    expect(result.current.disabled).toBe(true)
  })

  it('counts a stored plan the background cannot read as in progress', async () => {
    const account = p2mrAccount()
    const plan = { ...unreadablePlanView('stored-1'), address: account.address }
    const { result } = renderSend(free(account), account, plan)
    await enter(result)
    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_open_holds_rest'))
    expect(result.current.feeDetail).toMatchObject({ inputCount: 106, leftBehindInputCount: 44 })
    expect(result.current.disabled).toBe(false)
  })

  it('sends an amount one transaction of the free outputs can pay as one transaction', async () => {
    const account = p2mrAccount()
    const utxos = free(account)
    const { result, wallet, navigation } = renderSend(utxos, account, openPlan(account))
    await enter(result, '0.00300000')
    await settle()

    await waitFor(() => expect(result.current.disabled).toBe(false))
    expect(result.current.sendPlanOpenText).toBe('')
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.leftBehindNote).toBeUndefined()
    expect(result.current.feeDetail?.inputCount).toBeGreaterThan(0)

    const toSignData = { psbtHex: '00' }
    wallet.createSendQbitPsbt.mockResolvedValue(toSignData)
    await act(async () => result.current.onClickNext())
    expect(wallet.prepareQbitSendPlan).not.toHaveBeenCalled()
    expect(wallet.createSendQbitPsbt.mock.calls[0]?.[0]).toMatchObject({
      to: RECIPIENT,
      amount: 300_000,
      qbitUtxos: utxos,
    })
    expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData })
  })

  it('offers what one transaction can send now, never what only a plan could', async () => {
    const account = p2mrAccount()
    const { result } = renderSend(free(account), account, openPlan(account))
    // More than a plan of the free outputs pays (931,828), and so more than
    // one transaction pays (661,173).
    await enter(result, '0.01400000')

    await waitFor(() => expect(result.current.sendPlanRefusal).toBeDefined())
    expect(result.current.sendPlanRefusal).toEqual({
      message: 'send_plan_short_of_fees',
      offerText: 'send_plan_max_sendable:0.00661173,QBT',
      offerButtonText: 'send_plan_use_max_sendable:0.00661173,QBT',
      unconfirmedText: '',
    })
    expect(result.current.disabled).toBe(true)

    // The amount offered goes in one transaction.
    act(() => result.current.onClickMaxSendable())
    expect(result.current.inputAmount).toBe('0.00661173')
    await waitFor(() => expect(result.current.disabled).toBe(false))
    expect(result.current.feeDetail).toMatchObject({ inputCount: 106 })
    expect(result.current.sendPlanRefusal).toBeUndefined()
    expect(result.current.sendPlanOpenText).toBe('')
  })

  it('does not count a completed plan that is not dismissed yet', async () => {
    const account = p2mrAccount()
    const { result, wallet } = renderSend(free(account), account, completedPlan(account))
    await enter(result)
    await settle()

    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    expect(result.current.sendPlanNotice).toMatchObject({
      title: 'send_plan_notice_title_everything:2',
      receives: '0.00931828 QBT',
    })
    expect(result.current.sendPlanOpenText).toBe('')
    expect(result.current.leftBehindNote).toBeUndefined()
    expect(result.current.disabled).toBe(false)

    wallet.prepareQbitSendPlan.mockResolvedValue({ ok: true, review: planReview() })
    await act(async () => result.current.onClickNext())
    expect(wallet.prepareQbitSendPlan.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'everything' },
    })
  })

  it("keeps an amount waiting on the background's plan_open when this page had not read the plan yet, and reads it", async () => {
    const account = p2mrAccount()
    const { result, wallet, navigation } = renderSend(free(account), account)
    await enter(result, '0.00700000')
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())

    // Another window started a plan that this page has not read yet.
    wallet.getQbitSendPlan.mockResolvedValue(openPlan(account))
    wallet.prepareQbitSendPlan.mockResolvedValue(PLAN_OPEN_ANSWER)
    await act(async () => result.current.onClickNext())

    expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.disabled).toBe(true)
    await waitFor(() => expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2))
    await settle()
    expect(result.current.sendPlanOpenText).toBe('send_plan_already_open')
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.disabled).toBe(true)
    act(() => result.current.onClickViewSendPlan())
    expect(navigation.navigate).toHaveBeenCalledWith('QbitSendPlanScreen')
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it("sends MAX as one transaction once the plan the background's plan_open named is read", async () => {
    const account = p2mrAccount()
    const { result, wallet } = renderSend(free(account), account)
    await enter(result)
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())

    wallet.getQbitSendPlan.mockResolvedValue(openPlan(account))
    wallet.prepareQbitSendPlan.mockResolvedValue(PLAN_OPEN_ANSWER)
    await act(async () => result.current.onClickNext())

    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_open_holds_rest'))
    expect(result.current.disabled).toBe(false)
    expect(result.current.sendPlanNotice).toBeUndefined()
    expect(result.current.leftBehindNote).toBe(
      'send_all_leaves_outputs_behind:106,0.00440000,QBT,44'
    )
    // Read again: the outputs were read before the plan held its own.
    await waitFor(() => expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(2))
    expect(wallet.prepareQbitSendPlan).toHaveBeenCalledTimes(1)
  })

  it('reads the outputs again when a plan starts after they were read, and prices MAX on the ones left free', async () => {
    const account = p2mrAccount()
    const { result, wallet } = renderSend(free(account), account)
    await enter(result)
    await waitFor(() => expect(result.current.sendPlanNotice).toBeDefined())
    expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(1)

    // A plan started in another window holds 30 of the outputs: the
    // background leaves them out of every read from then on.
    wallet.getQbitUtxoSnapshot.mockResolvedValue({
      address: account.address,
      chain: ChainType.QBIT_MAINNET,
      utxos: free(account).slice(30),
    })
    wallet.getQbitSendPlan.mockResolvedValue(openPlan(account))
    await planChanged('plan-1', 1)

    await waitFor(() => expect(result.current.availableAmount).toBe('0.01200000'))
    expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(2)
    act(() => result.current.onAmountMaxClick())
    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_open_holds_rest'))
    expect(result.current.inputAmount).toBe('0.01200000')
    expect(result.current.feeDetail).toMatchObject({
      inputCount: 106,
      leftBehindInputCount: 14,
      leftBehindSats: 140_000,
    })
    expect(result.current.disabled).toBe(false)
  })

  it('reads the outputs again when the plan changes its transactions, not as it moves on', async () => {
    const account = p2mrAccount()
    const { result, wallet } = renderSend(free(account), account, openPlan(account))
    await enter(result)
    await waitFor(() => expect(result.current.sendPlanOpenText).toBe('send_plan_open_holds_rest'))

    // Signing moves on: what the plan holds stays the same.
    wallet.getQbitSendPlan.mockResolvedValue(
      openPlan(account, {
        revision: 2,
        signaturesDone: 50,
        signing: { step: 0, signed: 50, total: 106 },
      })
    )
    await planChanged('plan-1', 2)
    await waitFor(() => expect(wallet.getQbitSendPlan).toHaveBeenCalledTimes(2))
    await settle()
    expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(1)

    // Reviewed again over other outputs: its transactions change.
    wallet.getQbitSendPlan.mockResolvedValue(
      openPlan(account, {
        revision: 3,
        steps: [
          { kind: 'merge', txid: 'cc'.repeat(32), inputCount: 106, fee: 398_827, status: 'planned' },
          { kind: 'payment', txid: 'dd'.repeat(32), inputCount: 50, fee: 190_000, status: 'planned' },
        ],
        paymentTxid: 'dd'.repeat(32),
      })
    )
    await planChanged('plan-1', 3)
    await waitFor(() => expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(2))
  })

  it('keeps the outputs of the later read when an earlier one lands after it', async () => {
    const account = p2mrAccount()
    const { result, wallet } = renderSend(free(account), account, openPlan(account))
    await waitFor(() => expect(result.current.availableAmount).toBe('0.01500000'))
    await settle()
    expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(1)

    const snapshot = (utxos: any[]) => ({
      address: account.address,
      chain: ChainType.QBIT_MAINNET,
      utxos,
    })
    const earlier = deferred<ReturnType<typeof snapshot>>()
    const later = deferred<ReturnType<typeof snapshot>>()
    wallet.getQbitUtxoSnapshot
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(later.promise)
    // Reviewed again, then sent: two reads, started in that order.
    wallet.getQbitSendPlan.mockResolvedValue(
      openPlan(account, {
        revision: 2,
        steps: [
          { kind: 'merge', txid: 'cc'.repeat(32), inputCount: 106, fee: 398_827, status: 'planned' },
          { kind: 'payment', txid: 'dd'.repeat(32), inputCount: 50, fee: 190_000, status: 'planned' },
        ],
        paymentTxid: 'dd'.repeat(32),
      })
    )
    await planChanged('plan-1', 2)
    await waitFor(() => expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(2))
    wallet.getQbitSendPlan.mockResolvedValue(completedPlan(account))
    await planChanged('plan-1', 9)
    await waitFor(() => expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(3))

    await act(async () => later.resolve(snapshot(free(account).slice(10))))
    await waitFor(() => expect(result.current.availableAmount).toBe('0.01400000'))
    await act(async () => earlier.resolve(snapshot(free(account).slice(50))))
    await settle()
    expect(result.current.availableAmount).toBe('0.01400000')
  })
})
