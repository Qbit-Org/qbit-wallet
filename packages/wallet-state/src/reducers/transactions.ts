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
    setUtxos(state, action: { payload: QbitUtxoSnapshot }) {
      state.utxos = action.payload.utxos
      state.utxosChain = action.payload.chain
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
    })
  },
})

export const transactionsActions = slice.actions
export default slice.reducer
