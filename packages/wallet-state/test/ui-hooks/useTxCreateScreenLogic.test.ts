import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { KeyringType } from '@qbit/wallet-shared'
import * as walletShared from '@qbit/wallet-shared'
import { AddressType, ChainType } from '@qbit/wallet-types'

import { useTxCreateScreenLogic } from '../../src/ui-hooks/useTxCreateScreenLogic'
import {
  estimateQbitP2mrSendAllPreflight,
  estimateQbitP2mrSendPreflight,
  usePrepareSendQBTCallback,
  usePushQbitTxCallback,
} from '../../src/hooks/transactions'
import { createHookTestHarness, createWalletMock } from './testHelpers'
import { accountActions } from '../../src/reducers/accounts'
import { transactionsActions } from '../../src/reducers/transactions'
import { settingsActions } from '../../src/reducers/settings'
import { uiActions } from '../../src/reducers/ui'
import { I18nContext } from '../../src/context/I18nContext'

function p2mrAccount(pubkeyHex = '11'.repeat(32)) {
  const pubkey = hexToBytes(pubkeyHex)
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const scriptPubKey = p2mrScriptPubKey(leafHash)
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

describe('TxCreateScreen state hooks', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the persisted RBF setting once instead of on every state update', async () => {
    const { wrapper, wallet } = createHookTestHarness()
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    await waitFor(() => {
      expect(wallet.getEnableRBF).toHaveBeenCalledTimes(1)
    })

    act(() => {
      result.current.onAmountInputChange('0.0001')
    })

    await waitFor(() => {
      expect(result.current.inputAmount).toBe('0.0001')
    })

    expect(wallet.getEnableRBF).toHaveBeenCalledTimes(1)
  })

  it('uses qbit P2MR dust for send screen validation', async () => {
    const { wrapper, store } = createHookTestHarness()
    const currentAddress = store.getState().accounts.current.address
    store.dispatch(
      accountActions.setBalanceV2({
        address: currentAddress,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00002854')
    })

    await waitFor(() => {
      expect(result.current.error).toContain('0.00002855')
      expect(result.current.disabled).toBe(true)
    })

    act(() => {
      result.current.onAmountInputChange('0.00002855')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('')
      expect(result.current.disabled).toBe(false)
    })
  })

  it('blocks wrong-network qbit P2MR recipients inline', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'ab'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const wrongNetworkRecipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'regtest')
    const sameNetworkRecipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: wrongNetworkRecipient, domain: '' })
      result.current.onAmountInputChange('0.00010000')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('invalid_address_format_for_selected_network')
      expect(result.current.disabled).toBe(true)
    })

    act(() => {
      result.current.onAddressInputChange({ address: sameNetworkRecipient, domain: '' })
    })

    await waitFor(() => {
      expect(result.current.error).toBe('')
      expect(result.current.disabled).toBe(false)
    })
  })

  it('blocks qbit sends when cached UTXOs are not spendable by the current P2MR script', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'aa'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: `5220${'44'.repeat(32)}`,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00010000')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('amount_exceeds_your_available_balance')
      expect(result.current.disabled).toBe(true)
    })
  })

  it('blocks qbit sends that fit balance but cannot cover P2MR fees', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'bb'.repeat(32),
        vout: 0,
        satoshis: 10_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 10_000,
          unavailableBalance: 0,
          totalBalance: 10_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00009500')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('amount_exceeds_your_available_balance')
      expect(result.current.disabled).toBe(true)
    })

    act(() => {
      result.current.onAmountInputChange('0.00008000')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('amount_exceeds_your_available_balance')
      expect(result.current.disabled).toBe(true)
    })

    act(() => {
      result.current.onAmountInputChange('0.00006000')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('')
      expect(result.current.disabled).toBe(false)
    })
  })

  it('uses full undiscounted P2MR witness sizes in send preflight', () => {
    const account = p2mrAccount()
    const utxos = [
      {
        txid: '12'.repeat(32),
        vout: 0,
        satoshis: 50_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]

    expect(
      estimateQbitP2mrSendPreflight({
        utxos,
        account: account as any,
        amount: 10_000,
        feeRate: 1,
      })
    ).toEqual({
      canCover: true,
      estimatedFee: 3_860,
      inputCount: 1,
      estimatedVsize: 3_860,
      changeDroppedSats: 0,
      maximumTotalFee: 38_600_000,
      inputsDominateFee: true,
      exceedsMaximumTotalFee: false,
      exceedsStandardSize: false,
      maxInputCount: 0,
      maxStandardAmount: 0,
    })
    expect(
      estimateQbitP2mrSendAllPreflight({
        utxos,
        account: account as any,
        feeRate: 1,
      })
    ).toEqual({
      canCover: true,
      estimatedFee: 3_817,
      outputSatoshis: 46_183,
      inputCount: 1,
      estimatedVsize: 3_817,
      changeDroppedSats: 0,
      maximumTotalFee: 38_170_000,
      inputsDominateFee: true,
      exceedsMaximumTotalFee: false,
      leftBehindInputCount: 0,
      leftBehindSats: 0,
    })
    expect(
      estimateQbitP2mrSendAllPreflight({
        utxos,
        account: account as any,
        feeRate: 1,
        memo: 'hello qbit',
      })
    ).toEqual({
      canCover: true,
      estimatedFee: 3_838,
      outputSatoshis: 46_162,
      inputCount: 1,
      estimatedVsize: 3_838,
      changeDroppedSats: 0,
      maximumTotalFee: 38_380_000,
      inputsDominateFee: true,
      exceedsMaximumTotalFee: false,
      leftBehindInputCount: 0,
      leftBehindSats: 0,
    })
  })

  it('preserves the exact no-change estimate when UTXOs cannot cover the spend', () => {
    const account = p2mrAccount()
    const utxos = [
      {
        txid: '13'.repeat(32),
        vout: 0,
        satoshis: 10_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]

    expect(
      estimateQbitP2mrSendPreflight({
        utxos,
        account: account as any,
        amount: 3_000,
        feeRate: 10_000,
      })
    ).toEqual({
      canCover: false,
      estimatedFee: 38_170_000,
      inputCount: 1,
      estimatedVsize: 3_817,
      changeDroppedSats: 0,
      maximumTotalFee: 38_170_000,
      inputsDominateFee: true,
      exceedsMaximumTotalFee: false,
      exceedsStandardSize: false,
      maxInputCount: 106,
      maxStandardAmount: 0,
    })
  })

  it('reports the sub-dust change remainder folded into the fee', () => {
    const account = p2mrAccount()
    const utxos = [
      {
        txid: '34'.repeat(32),
        vout: 0,
        satoshis: 10_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]

    // 10_000 - 6_000 leaves 140 sats after the with-change fee (3_860), which is
    // below the 2_855 dust floor, so the 183-sat remainder above the no-change
    // fee (3_817) is paid as fee instead of returned as change.
    expect(
      estimateQbitP2mrSendPreflight({
        utxos,
        account: account as any,
        amount: 6_000,
        feeRate: 1,
      })
    ).toEqual({
      canCover: true,
      estimatedFee: 4_000,
      inputCount: 1,
      estimatedVsize: 3_817,
      changeDroppedSats: 183,
      maximumTotalFee: 38_170_000,
      inputsDominateFee: true,
      exceedsMaximumTotalFee: false,
      exceedsStandardSize: false,
      maxInputCount: 0,
      maxStandardAmount: 0,
    })
  })

  it('continues past an over-ceiling no-change candidate when a later UTXO enables safe change', () => {
    const account = p2mrAccount()
    const utxos = [
      {
        txid: '35'.repeat(32),
        vout: 0,
        satoshis: 100_000_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      },
      {
        txid: '36'.repeat(32),
        vout: 1,
        satoshis: 50_000_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      },
    ] as any
    const params = {
      account: account as any,
      amount: 61_829_900,
      feeRate: 10_000,
    }

    expect(estimateQbitP2mrSendPreflight({ ...params, utxos: utxos.slice(0, 1) })).toEqual({
      canCover: true,
      estimatedFee: 38_170_100,
      inputCount: 1,
      estimatedVsize: 3_817,
      changeDroppedSats: 100,
      maximumTotalFee: 38_170_000,
      inputsDominateFee: true,
      exceedsMaximumTotalFee: true,
      exceedsStandardSize: false,
      maxInputCount: 106,
      maxStandardAmount: 61_830_000,
    })
    expect(estimateQbitP2mrSendPreflight({ ...params, utxos })).toEqual({
      canCover: true,
      estimatedFee: 76_220_000,
      inputCount: 2,
      estimatedVsize: 7_622,
      changeDroppedSats: 0,
      maximumTotalFee: 76_220_000,
      inputsDominateFee: true,
      exceedsMaximumTotalFee: false,
      exceedsStandardSize: false,
      maxInputCount: 0,
      maxStandardAmount: 0,
    })
  })

  it('threads the memo into prepare and sends no memo when it is empty', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'ad'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00010000')
      result.current.onMemoChange('hello qbit')
    })
    await waitFor(() => {
      expect(result.current.disabled).toBe(false)
    })

    act(() => {
      result.current.onClickNext()
    })
    await waitFor(() => {
      expect(wallet.createSendQbitPsbt).toHaveBeenCalledWith(
        expect.objectContaining({ memo: 'hello qbit' })
      )
    })

    act(() => {
      result.current.onMemoChange('')
    })
    await waitFor(() => {
      expect(result.current.memo).toBe('')
    })
    act(() => {
      result.current.onClickNext()
    })
    await waitFor(() => {
      expect(wallet.createSendQbitPsbt).toHaveBeenCalledTimes(2)
    })
    expect(wallet.createSendQbitPsbt).toHaveBeenLastCalledWith(
      expect.objectContaining({ memo: undefined })
    )
  })

  it('surfaces the immature/pending balance split when immature coinbase exists', async () => {
    const account = p2mrAccount()
    const { wrapper, store } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 40_000,
          unavailableBalance: 35_000,
          totalBalance: 75_000,
          immatureBalance: 25_000,
          pendingBalance: 10_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.showImmature).toBe(true)
    expect(result.current.immatureAmount).toBe('0.00025000')
    expect(result.current.showPending).toBe(true)
    expect(result.current.pendingAmount).toBe('0.00010000')
  })

  it('does not label other-script confirmed funds as pending', async () => {
    const account = p2mrAccount()
    const { wrapper, store } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          // Unavailable includes 10_000 of confirmed funds on another script:
          // immature 25_000 + other-script 10_000, zero mempool.
          availableBalance: 40_000,
          unavailableBalance: 35_000,
          totalBalance: 75_000,
          immatureBalance: 25_000,
          pendingBalance: 0,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.showImmature).toBe(true)
    expect(result.current.showPending).toBe(false)
  })

  it('surfaces pending funds without requiring an immature balance', async () => {
    const account = p2mrAccount()
    const { wrapper, store } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 40_000,
          unavailableBalance: 10_000,
          totalBalance: 50_000,
          pendingBalance: 10_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.showUnavailable).toBe(true)
    expect(result.current.showImmature).toBe(false)
    expect(result.current.showPending).toBe(true)
    expect(result.current.pendingAmount).toBe('0.00010000')
  })

  it('bounds displayed detail rows to their Unavailable parent', async () => {
    const account = p2mrAccount()
    const { wrapper, store } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 40_000,
          unavailableBalance: 30_000,
          totalBalance: 70_000,
          immatureBalance: 25_000,
          pendingBalance: 10_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.unavailableAmount).toBe('0.00030000')
    expect(result.current.immatureAmount).toBe('0.00025000')
    expect(result.current.pendingAmount).toBe('0.00005000')
    const displayedChildSats = Math.round(
      (Number(result.current.immatureAmount) + Number(result.current.pendingAmount)) * 1e8
    )
    const displayedUnavailableSats = Math.round(Number(result.current.unavailableAmount) * 1e8)
    expect(displayedChildSats).toBeLessThanOrEqual(displayedUnavailableSats)
  })

  it('hides the immature split when the balance reports none', async () => {
    const account = p2mrAccount()
    const { wrapper, store } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 40_000,
          unavailableBalance: 5_000,
          totalBalance: 45_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.showImmature).toBe(false)
  })

  it('passes a send-all memo into the controller after accounting for its exact size', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet, navigation } = createHookTestHarness()
    const utxos = [
      {
        txid: 'af'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    const toSignData = { psbtHex: 'send-all-with-memo' }
    wallet.createSendAllQbitPsbt.mockResolvedValue(toSignData as any)
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const recipient = p2mrAddressFromPubkey(hexToBytes('44'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    await waitFor(() => {
      expect(wallet.getEnableRBF).toHaveBeenCalledTimes(1)
      expect(result.current.enableRBF).toBe(false)
    })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onMemoChange('hello qbit')
      result.current.onAmountMaxClick()
    })
    await waitFor(() => {
      expect(result.current.disabled).toBe(false)
    })
    expect(result.current.feeDetail).toEqual({
      inputCount: 1,
      estimatedVsize: 3_838,
      changeDroppedSats: 0,
      estimatedFee: 3_838,
      maximumTotalFee: 38_380_000,
      inputsDominateFee: true,
      leftBehindInputCount: 0,
      leftBehindSats: 0,
    })

    act(() => {
      result.current.onClickNext()
    })
    await waitFor(() => {
      expect(wallet.createSendAllQbitPsbt).toHaveBeenCalledWith({
        to: recipient,
        qbitUtxos: utxos,
        qbitUtxoChain: ChainType.QBIT_MAINNET,
        feeRate: 1,
        enableRBF: false,
        memo: 'hello qbit',
        memos: undefined,
      })
    })
    expect(result.current.error).toBe('')
    await waitFor(() => {
      expect(navigation.navigate).toHaveBeenCalledWith('TxConfirmScreen', { toSignData })
    })
    expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
  })

  it('rejects memos above the OP_RETURN byte cap using backend byte semantics', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'ae'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00010000')
      result.current.onMemoChange('x'.repeat(81))
    })
    await waitFor(() => {
      expect(result.current.error).toBe('memo_too_long_max_80_bytes')
      expect(result.current.disabled).toBe(true)
    })

    // 160 hex characters encode as 80 bytes, matching the controller's
    // hex-as-bytes memo handling, so this must pass the byte cap.
    act(() => {
      result.current.onMemoChange('ab'.repeat(80))
    })
    await waitFor(() => {
      expect(result.current.error).toBe('')
      expect(result.current.disabled).toBe(false)
    })
  })

  it('surfaces preflight fee details including the folded sub-dust change', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'af'.repeat(32),
        vout: 0,
        satoshis: 10_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 10_000,
          unavailableBalance: 0,
          totalBalance: 10_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    // A change output above dust: fee detail reports the with-change estimate.
    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00003000')
    })
    await waitFor(() => {
      expect(result.current.feeDetail).toEqual({
        estimatedFee: 3_860,
        inputCount: 1,
        estimatedVsize: 3_860,
        changeDroppedSats: 0,
        maximumTotalFee: 38_600_000,
        inputsDominateFee: true,
        leftBehindInputCount: 0,
        leftBehindSats: 0,
      })
    })

    // A sub-dust remainder folds into the fee and is reported as dropped.
    act(() => {
      result.current.onAmountInputChange('0.00006000')
    })
    await waitFor(() => {
      expect(result.current.feeDetail).toEqual({
        estimatedFee: 4_000,
        inputCount: 1,
        estimatedVsize: 3_817,
        changeDroppedSats: 183,
        maximumTotalFee: 38_170_000,
        inputsDominateFee: true,
        leftBehindInputCount: 0,
        leftBehindSats: 0,
      })
    })

    // Invalid amounts clear the fee detail.
    act(() => {
      result.current.onAmountInputChange('0.00002000')
    })
    await waitFor(() => {
      expect(result.current.feeDetail).toBeUndefined()
      expect(result.current.disabled).toBe(true)
    })
  })

  it('blocks a qbit custom rate below the relay minimum before preflight', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'b8'.repeat(32),
        vout: 0,
        satoshis: 100_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    store.dispatch(
      (uiActions as any).updateFeeRateBar({
        feeRate: 0.1,
        feeRateInputVal: '0.1',
        feeOptionIndex: 3,
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00010000')
    })

    await waitFor(() => {
      expect(result.current.disabled).toBe(true)
      expect(result.current.feeDetail).toBeUndefined()
    })
    expect(store.getState().ui.feeRateBar).toMatchObject({
      feeRate: 0.1,
      feeRateInputVal: '0.1',
      feeOptionIndex: 3,
    })
    expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
    expect(wallet.createSendAllQbitPsbt).not.toHaveBeenCalled()
  })

  it('blocks an above-ceiling custom rate and reports the exact size-based maximum', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'b9'.repeat(32),
        vout: 0,
        satoshis: 100_000_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000_000,
          unavailableBalance: 0,
          totalBalance: 100_000_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    store.dispatch(
      (uiActions as any).updateFeeRateBar({
        feeRate: 10_001,
        feeRateInputVal: '10001',
        feeOptionIndex: 3,
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00010000')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('fee_exceeds_wallet_safety_maximum')
      expect(result.current.disabled).toBe(true)
      expect(result.current.feeDetail).toBeUndefined()
    })
    expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
  })

  it('prioritizes an above-ceiling custom rate when the clamped fee cannot be covered', async () => {
    const account = p2mrAccount()
    const { wrapper: baseWrapper, store, wallet } = createHookTestHarness()
    const t = vi.fn(
      (key: string, _substitutions?: string | string[] | Record<string, string | number>) => key
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
    const utxos = [
      {
        txid: 'ba'.repeat(32),
        vout: 0,
        satoshis: 10_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 10_000,
          unavailableBalance: 0,
          totalBalance: 10_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    store.dispatch(
      (uiActions as any).updateFeeRateBar({
        feeRate: 10_001,
        feeRateInputVal: '10001',
        feeOptionIndex: 3,
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00003000')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('fee_exceeds_wallet_safety_maximum')
      expect(result.current.disabled).toBe(true)
      expect(result.current.feeDetail).toBeUndefined()
    })
    expect(t).toHaveBeenCalledWith('fee_exceeds_wallet_safety_maximum', [
      '10000',
      '0.38170000',
      'QBT',
    ])
  })

  it('keeps Next disabled for P2MR sends until spendable UTXOs load', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    // Balance is cached, but UTXOs have not loaded (the snapshot never
    // arrives), so the fee preflight can't run. Next must stay disabled rather
    // than enabling from accountBalance alone.
    wallet.getQbitUtxoSnapshot.mockReturnValue(new Promise(() => undefined))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 100_000,
          unavailableBalance: 0,
          totalBalance: 100_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    // Drive the validation effect to a known error state first.
    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.00002854')
    })
    await waitFor(() => {
      expect(result.current.error).toContain('0.00002855')
      expect(result.current.disabled).toBe(true)
    })

    // A within-balance, above-dust amount clears the error, but Next stays
    // disabled because the P2MR preflight has no UTXOs to validate against.
    act(() => {
      result.current.onAmountInputChange('0.00010000')
    })
    await waitFor(() => {
      expect(result.current.error).toBe('')
      expect(result.current.disabled).toBe(true)
    })
  })

  it('shows the spendable UTXO total as Available, the amount Max fills and the preflight checks (#279)', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    const utxos = [
      {
        txid: 'ee'.repeat(32),
        vout: 0,
        satoshis: 10_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    // A balance read older than the outputs the send may select: 5_000 of
    // them (own change, say) had not reached it yet.
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 5_000,
          unavailableBalance: 5_000,
          totalBalance: 10_000,
          pendingBalance: 5_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.availableAmount).toBe('0.00010000')
    expect(result.current.showUnavailable).toBe(false)
    expect(result.current.showPending).toBe(false)

    act(() => {
      result.current.onAmountMaxClick()
    })

    await waitFor(() => {
      expect(result.current.inputAmount).toBe(result.current.availableAmount)
    })
  })

  it('shows Available as 0 once the outputs load with none left to select (#279)', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    // The balance still counts outputs that a pending send holds.
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 40_000,
          unavailableBalance: 0,
          totalBalance: 40_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    await waitFor(() => expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalled())
    await waitFor(() => {
      expect(result.current.availableAmount).toBe('0.00000000')
      expect(result.current.unavailableAmount).toBe('0.00040000')
    })

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.0001')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('amount_exceeds_your_available_balance')
      expect(result.current.disabled).toBe(true)
    })
  })

  it('does not take an empty cache from an earlier read as this screen’s outputs (#279)', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    // Left by another account's read on the same network; this screen's own
    // read has not landed yet.
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos: [] }))
    wallet.getQbitUtxoSnapshot.mockReturnValue(new Promise(() => undefined))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 40_000,
          unavailableBalance: 0,
          totalBalance: 40_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.availableAmount).toBe('0.00040000')
    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.0001')
    })
    await waitFor(() => {
      expect(result.current.error).toBe('')
      expect(result.current.disabled).toBe(true)
    })
  })

  it('moves outputs a pending send holds out of Available and refuses amounts above it (#279)', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    // The balance still counts a 30_000 output that a broadcast just spent;
    // the snapshot of selectable outputs already leaves it out.
    const utxos = [
      {
        txid: 'ef'.repeat(32),
        vout: 1,
        satoshis: 50_000,
        scriptPk: account.p2mr.scriptPubKey,
        pubkey: account.pubkey,
        addressType: AddressType.P2MR,
      } as any,
    ]
    wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      accountActions.setBalanceV2({
        address: account.address,
        balance: {
          availableBalance: 80_000,
          unavailableBalance: 0,
          totalBalance: 80_000,
          chainType: ChainType.QBIT_MAINNET,
        },
      })
    )
    store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

    expect(result.current.availableAmount).toBe('0.00050000')
    expect(result.current.showUnavailable).toBe(true)
    expect(result.current.unavailableAmount).toBe('0.00030000')

    act(() => {
      result.current.onAddressInputChange({ address: recipient, domain: '' })
      result.current.onAmountInputChange('0.0006')
    })

    await waitFor(() => {
      expect(result.current.error).toBe('amount_exceeds_your_available_balance')
      expect(result.current.disabled).toBe(true)
    })
  })

  it('prepare send rejects UTXOs that do not match the current P2MR script', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      transactionsActions.setUtxos({
        chain: ChainType.QBIT_MAINNET,
        utxos: [
          {
            txid: 'cc'.repeat(32),
            vout: 0,
            satoshis: 100_000,
            scriptPk: `5220${'55'.repeat(32)}`,
            pubkey: account.pubkey,
            addressType: AddressType.P2MR,
          },
        ],
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => usePrepareSendQBTCallback(), { wrapper })

    await expect(
      result.current({
        toAddressInfo: { address: recipient },
        toAmount: 10_000,
        feeRate: 1,
      })
    ).rejects.toThrow('insufficient_balance')
    expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
  })

  it('prepare send reserves P2MR fees before creating the PSBT', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    store.dispatch(
      transactionsActions.setUtxos({
        chain: ChainType.QBIT_MAINNET,
        utxos: [
          {
            txid: 'dd'.repeat(32),
            vout: 0,
            satoshis: 10_000,
            scriptPk: account.p2mr.scriptPubKey,
            pubkey: account.pubkey,
            addressType: AddressType.P2MR,
          },
        ],
      })
    )
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    const { result } = renderHook(() => usePrepareSendQBTCallback(), { wrapper })

    await expect(
      result.current({
        toAddressInfo: { address: recipient },
        toAmount: 9_500,
        feeRate: 1,
      })
    ).rejects.toThrow('insufficient_balance')
    expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
  })

  it('prepare send hands the builder the network its cached outputs were loaded on, reloading a cache from another network first', async () => {
    const account = p2mrAccount()
    const { wrapper, store, wallet } = createHookTestHarness()
    store.dispatch(accountActions.setCurrent(account))
    const utxo = (txid: string) => ({
      txid,
      vout: 0,
      satoshis: 100_000,
      scriptPk: account.p2mr.scriptPubKey,
      pubkey: account.pubkey,
      addressType: AddressType.P2MR,
    })
    wallet.createSendQbitPsbt.mockResolvedValue({ psbtHex: 'prepared' } as any)
    const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
    // A cache loaded on the active network is used as is, and the network
    // it was loaded on travels with the outputs.
    store.dispatch(
      transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos: [utxo('ee'.repeat(32))] })
    )
    const { result } = renderHook(() => usePrepareSendQBTCallback(), { wrapper })

    await act(async () => {
      await result.current({
        toAddressInfo: { address: recipient },
        toAmount: 10_000,
        feeRate: 1,
      })
    })
    expect(wallet.getQbitUtxoSnapshot).not.toHaveBeenCalled()
    expect(wallet.createSendQbitPsbt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        qbitUtxos: [utxo('ee'.repeat(32))],
        qbitUtxoChain: ChainType.QBIT_MAINNET,
      })
    )

    // Another window switched networks after the cache was loaded: the
    // cached outputs exist only on the old network (their scriptPubKey is
    // the same on both), so they are reloaded on the active one and the
    // reloaded snapshot's network is what the builder receives.
    act(() => {
      store.dispatch(settingsActions.updateSettings({ chainType: ChainType.QBIT_TESTNET4 }))
    })
    wallet.getQbitUtxoSnapshot.mockResolvedValueOnce({
      chain: ChainType.QBIT_TESTNET4,
      utxos: [utxo('ef'.repeat(32))],
    })
    await act(async () => {
      await result.current({
        toAddressInfo: { address: recipient },
        toAmount: 10_000,
        feeRate: 1,
      })
    })
    expect(wallet.getQbitUtxoSnapshot).toHaveBeenCalledTimes(1)
    expect(wallet.createSendQbitPsbt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        qbitUtxos: [utxo('ef'.repeat(32))],
        qbitUtxoChain: ChainType.QBIT_TESTNET4,
      })
    )
    expect(store.getState().transactions.utxosChain).toBe(ChainType.QBIT_TESTNET4)
  })

  it('prepare send rejects an exact-size fee above the safety maximum for both PSBT paths', async () => {
    // Fee and ceiling come from the shared selectors; force a priced fee over
    // its ceiling on both paths.
    const realSend = walletShared.selectQbitP2mrSendCoins
    const realSendAll = walletShared.selectQbitP2mrSendAllCoins
    const sendSpy = vi
      .spyOn(walletShared, 'selectQbitP2mrSendCoins')
      .mockImplementation(params => ({ ...realSend(params), maximumTotalFee: 1 }) as any)
    const sendAllSpy = vi
      .spyOn(walletShared, 'selectQbitP2mrSendAllCoins')
      .mockImplementation(params => ({ ...realSendAll(params), maximumTotalFee: 1 }))
    try {
      const account = p2mrAccount()
      const { wrapper, store, wallet } = createHookTestHarness()
      const utxos = [
        {
          txid: 'de'.repeat(32),
          vout: 0,
          satoshis: 100_000,
          scriptPk: account.p2mr.scriptPubKey,
          pubkey: account.pubkey,
          addressType: AddressType.P2MR,
        },
      ] as any
      store.dispatch(accountActions.setCurrent(account))
      store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
      const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
      const { result } = renderHook(() => usePrepareSendQBTCallback(), { wrapper })

      await expect(
        result.current({
          toAddressInfo: { address: recipient },
          toAmount: 10_000,
          feeRate: 1,
        })
      ).rejects.toThrow('fee_exceeds_wallet_safety_maximum')
      await expect(
        result.current({
          toAddressInfo: { address: recipient },
          toAmount: 100_000,
          feeRate: 1,
        })
      ).rejects.toThrow('fee_exceeds_wallet_safety_maximum')

      expect(wallet.createSendQbitPsbt).not.toHaveBeenCalled()
      expect(wallet.createSendAllQbitPsbt).not.toHaveBeenCalled()
    } finally {
      sendSpy.mockRestore()
      sendAllSpy.mockRestore()
    }
  })

  it('refetches balance immediately and on retry timers after qbit broadcast', async () => {
    vi.useFakeTimers()
    const account = p2mrAccount()
    const wallet = {
      ...createWalletMock(),
      broadcastQbitTx: vi.fn().mockResolvedValue({
        success: true,
        chain: ChainType.QBIT_MAINNET,
        txid: 'qbit-txid',
        via: 'broadcast',
      }),
      getAddressSummary: vi.fn().mockResolvedValue({
        totalSatoshis: 90_000,
        spendableSatoshis: 90_000,
      }),
      getAddressBalanceV2: vi.fn().mockResolvedValue({
        availableBalance: 80_000,
        unavailableBalance: 10_000,
        totalBalance: 90_000,
        chainType: ChainType.QBIT_MAINNET,
      }),
    }
    const { wrapper, store } = createHookTestHarness({ wallet: wallet as any })
    store.dispatch(accountActions.setCurrent(account))
    const { result } = renderHook(() => usePushQbitTxCallback(), { wrapper })
    let response: Awaited<ReturnType<ReturnType<typeof usePushQbitTxCallback>>> | undefined

    await act(async () => {
      const pushPromise = result.current({ psbtHex: 'signed-rawtx' })
      await vi.advanceTimersByTimeAsync(3000)
      response = await pushPromise
      await Promise.resolve()
    })

    expect(response).toEqual({
      success: true,
      chain: ChainType.QBIT_MAINNET,
      txid: 'qbit-txid',
      via: 'broadcast',
    })
    expect(wallet.broadcastQbitTx).toHaveBeenCalledWith(
      'signed-rawtx',
      undefined,
      undefined,
      undefined
    )
    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(1)
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(1)
    expect(wallet.getAddressSummary).toHaveBeenCalledWith(account.address)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.resolve()
    })

    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(2)
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
    })

    expect(wallet.getAddressSummary).toHaveBeenCalledTimes(3)
    expect(wallet.getAddressBalanceV2).toHaveBeenCalledTimes(3)
  })

  it('does not refetch balance after failed qbit broadcast', async () => {
    const wallet = {
      ...createWalletMock(),
      broadcastQbitTx: vi.fn().mockResolvedValue({
        success: false,
        chain: ChainType.QBIT_MAINNET,
        txid: 'qbit-txid',
        outcome: 'unknown',
        reason: 'network',
        lookup: 'gone',
      }),
      getAddressSummary: vi.fn(),
      getAddressBalanceV2: vi.fn(),
    }
    const { wrapper } = createHookTestHarness({ wallet: wallet as any })
    const { result } = renderHook(() => usePushQbitTxCallback(), { wrapper })
    let response: Awaited<ReturnType<ReturnType<typeof usePushQbitTxCallback>>> | undefined

    await act(async () => {
      response = await result.current({ psbtHex: 'signed-rawtx' })
    })

    expect(response).toMatchObject({ success: false, outcome: 'unknown', reason: 'network' })
    expect(wallet.getAddressSummary).not.toHaveBeenCalled()
    expect(wallet.getAddressBalanceV2).not.toHaveBeenCalled()
  })

  describe('accounts with many outputs', () => {
    function withRecordingI18n(baseWrapper: ({ children }: { children: ReactNode }) => any) {
      const t = vi.fn(
        (key: string, _substitutions?: string | string[] | Record<string, string | number>) => key
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

    function manyOutputs(account: ReturnType<typeof p2mrAccount>, values: number[]) {
      return values.map(
        (satoshis, index) =>
          ({
            txid: (index + 1).toString(16).padStart(64, '0'),
            vout: 0,
            satoshis,
            scriptPk: account.p2mr.scriptPubKey,
            pubkey: account.pubkey,
            addressType: AddressType.P2MR,
          }) as any
      )
    }

    function loadAccount(
      harness: ReturnType<typeof createHookTestHarness>,
      account: ReturnType<typeof p2mrAccount>,
      utxos: any[]
    ) {
      const total = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0)
      harness.wallet.getQbitUtxoSnapshot.mockResolvedValue({ chain: ChainType.QBIT_MAINNET, utxos })
      harness.store.dispatch(accountActions.setCurrent(account))
      harness.store.dispatch(
        accountActions.setBalanceV2({
          address: account.address,
          balance: {
            availableBalance: total,
            unavailableBalance: 0,
            totalBalance: total,
            chainType: ChainType.QBIT_MAINNET,
          },
        })
      )
      harness.store.dispatch(transactionsActions.setUtxos({ chain: ChainType.QBIT_MAINNET, utxos }))
    }

    it('explains an account over the explorer UTXO limit instead of silently disabling Next', async () => {
      const account = p2mrAccount()
      const harness = createHookTestHarness()
      harness.wallet.getQbitUtxoSnapshot.mockRejectedValue(new Error('HTTP 500'))
      // The cache still holds the previously loaded account's outputs.
      const previousAccount = p2mrAccount('22'.repeat(32))
      harness.store.dispatch(
        transactionsActions.setUtxos({
          chain: ChainType.QBIT_MAINNET,
          utxos: manyOutputs(previousAccount, [50_000]),
        })
      )
      harness.store.dispatch(accountActions.setCurrent(account))
      harness.store.dispatch(
        accountActions.setBalanceV2({
          address: account.address,
          balance: {
            availableBalance: 0,
            unavailableBalance: 91_000_000,
            totalBalance: 91_000_000,
            utxoLimitExceeded: true,
            chainType: ChainType.QBIT_MAINNET,
          },
        })
      )
      const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper: harness.wrapper })

      await waitFor(() => {
        expect(result.current.error).toBe('utxo_limit_exceeded_send')
        expect(result.current.disabled).toBe(true)
      })
      // Unknown, not zero, and the way out is offered.
      expect(result.current.availableAmount).toBe('--')
      expect(result.current.showConsolidate).toBe(true)
      act(() => {
        result.current.onClickConsolidate()
      })
      expect(harness.navigation.navigate).toHaveBeenCalledWith('QbitConsolidationScreen')
    })

    it('shows the outputs as unknown, without an error, while an over-limit read is still running', async () => {
      const account = p2mrAccount()
      const harness = createHookTestHarness()
      harness.wallet.getQbitUtxoSnapshot.mockReturnValue(new Promise(() => {}))
      harness.store.dispatch(accountActions.setCurrent(account))
      harness.store.dispatch(
        accountActions.setBalanceV2({
          address: account.address,
          balance: {
            availableBalance: 0,
            unavailableBalance: 6_000_000,
            totalBalance: 6_000_000,
            utxoLimitExceeded: true,
            chainType: ChainType.QBIT_MAINNET,
          },
        })
      )
      const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper: harness.wrapper })

      await waitFor(() => expect(result.current.availableAmount).toBe('--'))
      expect(result.current.error).toBe('')
      expect(result.current.disabled).toBe(true)
      // The walk does not cover the screen, so Consolidate stays in reach.
      expect(harness.tools.showLoading).not.toHaveBeenCalledWith(true)
      // Max agrees with Available: it has nothing to fill yet.
      act(() => {
        result.current.onAmountMaxClick()
      })
      expect(result.current.inputAmount).toBeFalsy()
    })

    it('takes the loading overlay down once the balance shows the account over the limit', async () => {
      const account = p2mrAccount()
      const harness = createHookTestHarness()
      harness.wallet.getQbitUtxoSnapshot.mockReturnValue(new Promise(() => {}))
      harness.store.dispatch(accountActions.setCurrent(account))
      renderHook(() => useTxCreateScreenLogic(), { wrapper: harness.wrapper })
      expect(harness.tools.showLoading).toHaveBeenLastCalledWith(true)

      act(() => {
        harness.store.dispatch(
          accountActions.setBalanceV2({
            address: account.address,
            balance: {
              availableBalance: 0,
              unavailableBalance: 6_000_000,
              totalBalance: 6_000_000,
              utxoLimitExceeded: true,
              chainType: ChainType.QBIT_MAINNET,
            },
          })
        )
      })

      expect(harness.tools.showLoading).toHaveBeenLastCalledWith(false)
    })

    it('shows 0, not unknown, once an over-limit account\'s outputs load with all of them held', async () => {
      const account = p2mrAccount()
      const harness = createHookTestHarness()
      harness.store.dispatch(accountActions.setCurrent(account))
      harness.store.dispatch(
        accountActions.setBalanceV2({
          address: account.address,
          balance: {
            availableBalance: 0,
            unavailableBalance: 6_000_000,
            totalBalance: 6_000_000,
            utxoLimitExceeded: true,
            chainType: ChainType.QBIT_MAINNET,
          },
        })
      )
      const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper: harness.wrapper })

      await waitFor(() => {
        expect(result.current.availableAmount).toBe('0.00000000')
      })
      expect(result.current.error).toBe('')
      expect(result.current.showConsolidate).toBe(true)
    })

    it('sends from the outputs read from history while still offering consolidation (#277)', async () => {
      const account = p2mrAccount()
      const harness = createHookTestHarness()
      const outputs = manyOutputs(account, Array(600).fill(10_000))
      loadAccount(harness, account, outputs)
      harness.store.dispatch(
        accountActions.setBalanceV2({
          address: account.address,
          balance: {
            availableBalance: 0,
            unavailableBalance: 6_000_000,
            totalBalance: 6_000_000,
            utxoLimitExceeded: true,
            chainType: ChainType.QBIT_MAINNET,
          },
        })
      )
      const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
      const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper: harness.wrapper })

      act(() => {
        result.current.onAddressInputChange({ address: recipient, domain: '' })
        result.current.onAmountInputChange('0.00050000')
      })

      await waitFor(() => {
        expect(result.current.disabled).toBe(false)
      })
      expect(result.current.error).toBe('')
      expect(result.current.availableAmount).toBe('0.06000000')
      expect(result.current.showConsolidate).toBe(true)
    })

    it('names the largest standard send when an amount needs more than 106 inputs', async () => {
      const account = p2mrAccount()
      const harness = createHookTestHarness()
      const { t, wrapper } = withRecordingI18n(harness.wrapper)
      loadAccount(harness, account, manyOutputs(account, Array(150).fill(10_000)))
      const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
      const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

      act(() => {
        result.current.onAddressInputChange({ address: recipient, domain: '' })
        result.current.onAmountInputChange('0.00700000')
      })

      await waitFor(() => {
        expect(result.current.error).toBe('send_exceeds_standard_size')
        expect(result.current.disabled).toBe(true)
      })
      // 106 inputs of 10,000 less the exact 398,827-bit fee.
      expect(t).toHaveBeenCalledWith('send_exceeds_standard_size', ['106', '0.00661173', 'QBT'])

      const { result: prepare } = renderHook(() => usePrepareSendQBTCallback(), { wrapper })
      await expect(
        prepare.current({
          toAddressInfo: { address: recipient },
          toAmount: 700_000,
          feeRate: 1,
        })
      ).rejects.toThrow('send_exceeds_standard_size')
      expect(harness.wallet.createSendQbitPsbt).not.toHaveBeenCalled()
    })

    it('discloses the outputs Max leaves behind past the standard size', async () => {
      const account = p2mrAccount()
      const harness = createHookTestHarness()
      const { t, wrapper } = withRecordingI18n(harness.wrapper)
      loadAccount(
        harness,
        account,
        manyOutputs(account, [...Array(44).fill(4_000), ...Array(106).fill(20_000)])
      )
      const recipient = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet')
      const { result } = renderHook(() => useTxCreateScreenLogic(), { wrapper })

      act(() => {
        result.current.onAddressInputChange({ address: recipient, domain: '' })
        result.current.onAmountMaxClick()
      })

      await waitFor(() => {
        expect(result.current.disabled).toBe(false)
      })
      expect(result.current.feeDetail).toMatchObject({
        inputCount: 106,
        leftBehindInputCount: 44,
        leftBehindSats: 176_000,
      })
      expect(result.current.leftBehindNote).toBe('send_all_leaves_outputs_behind')
      expect(t).toHaveBeenCalledWith('send_all_leaves_outputs_behind', [
        '106',
        '0.00176000',
        'QBT',
        '44',
      ])
    })
  })
})
