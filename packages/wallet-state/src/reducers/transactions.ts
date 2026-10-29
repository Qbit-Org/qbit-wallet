import { QbitUtxoSnapshot, UnspentOutput } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { createSlice, Slice } from '@reduxjs/toolkit'

import { updateVersion } from '../actions/global'

export interface QbitTx {
  fromAddress: string
  toAddress: string
  toSatoshis: number
  rawtx: string
  txid: string
  fee: number
  estimateFee: number
  changeSatoshis: number
  sending: boolean
  autoAdjust: boolean
  psbtHex: string
  feeRate: number
}

export interface TransactionsState {
  qbitTx: QbitTx
  utxos: UnspentOutput[]
  /**
   * The network `utxos` were loaded on, or null before the first load. The
   * cache is not cleared by a network switch in another window, and the
   * outputs themselves cannot say which network they exist on, so a send
   * built from them carries this chain for the background to check.
   */
  utxosChain: ChainType | null
  /**
   * The account `utxos` were read for, or null before the first load. The
   * cache holds one account's outputs at a time, and readers take them only
   * while that account and `utxosChain` are the selected ones.
   */
  utxosAddress: string | null
  /**
   * The read whose answer `utxos` holds (see `useFetchUtxosCallback`), or 0
   * for outputs set without one. An answer from an earlier read never
   * replaces a later read's for the same account and network.
   */
  utxosRead: number
  spendUnavailableUtxos: UnspentOutput[]
}

export const initialState: TransactionsState = {
  qbitTx: {
    fromAddress: '',
    toAddress: '',
    toSatoshis: 0,
    rawtx: '',
    txid: '',
    fee: 0,
    estimateFee: 0,
    changeSatoshis: 0,
    sending: false,
    autoAdjust: false,
    psbtHex: '',
    feeRate: 5,
  },
  utxos: [],
  utxosChain: null,
  utxosAddress: null,
  utxosRead: 0,
  spendUnavailableUtxos: [],
}

const slice: Slice<TransactionsState> = createSlice({
  name: 'transactions',
  initialState,
  reducers: {
    updateQbitTx(
      state,
      action: {
        payload: {
          fromAddress?: string
          toAddress?: string
          toSatoshis?: number
          changeSatoshis?: number
          rawtx?: string
          txid?: string
          fee?: number
          estimateFee?: number
          sending?: boolean
          autoAdjust?: boolean
          psbtHex?: string
          feeRate?: number
        }
      }
    ) {
      const { payload } = action
      state.qbitTx = Object.assign({}, state.qbitTx, payload)
    },
    setUtxos(state, action: { payload: QbitUtxoSnapshot & { read?: number } }) {
      state.utxos = action.payload.utxos
      state.utxosChain = action.payload.chain
      state.utxosAddress = action.payload.address
      state.utxosRead = action.payload.read ?? 0
    },
    setSpendUnavailableUtxos(state, action: { payload: UnspentOutput[] }) {
      state.spendUnavailableUtxos = action.payload
    },
    reset(state) {
      return initialState
    },
  },

  extraReducers: builder => {
    builder.addCase(updateVersion, state => {
      if (!state.spendUnavailableUtxos) {
        state.spendUnavailableUtxos = []
      }
      if (state.utxosChain === undefined) {
        state.utxosChain = null
      }
      if (state.utxosAddress === undefined) {
        state.utxosAddress = null
      }
      if (state.utxosRead === undefined) {
        state.utxosRead = 0
      }
    })
  },
})

export const transactionsActions = slice.actions
export default slice.reducer
