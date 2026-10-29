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
  /**
   * When the read whose answer `utxos` holds landed (milliseconds since the
   * epoch), or 0 for outputs set without one.
   */
  utxosReadAt: number
  /**
   * `broadcasts` as it stood when the read whose answer `utxos` holds
   * started, or -1 for outputs set without one.
   */
  utxosBroadcasts: number
  /**
   * Broadcasts this window published: sends, fee bumps and consolidation
   * batches, counted as each one's txid lands in `qbitTx`. A read of the
   * outputs that started before the latest one can still list the outputs
   * it spent and miss its change.
   */
  broadcasts: number
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
  utxosReadAt: 0,
  utxosBroadcasts: -1,
  broadcasts: 0,
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
      if (payload.txid) state.broadcasts += 1
    },
    setUtxos(
      state,
      action: {
        payload: QbitUtxoSnapshot & { read?: number; readAt?: number; broadcasts?: number }
      }
    ) {
      state.utxos = action.payload.utxos
      state.utxosChain = action.payload.chain
      state.utxosAddress = action.payload.address
      state.utxosRead = action.payload.read ?? 0
      state.utxosReadAt = action.payload.readAt ?? 0
      state.utxosBroadcasts = action.payload.broadcasts ?? -1
    },
    setSpendUnavailableUtxos(state, action: { payload: UnspentOutput[] }) {
      state.spendUnavailableUtxos = action.payload
    },
    reset(state) {
      // The count only grows, so a read that started before the reset can
      // never pass for one that started after a later broadcast.
      return { ...initialState, broadcasts: state.broadcasts }
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
      if (state.utxosReadAt === undefined) {
        state.utxosReadAt = 0
      }
      if (state.utxosBroadcasts === undefined) {
        state.utxosBroadcasts = -1
      }
      if (state.broadcasts === undefined) {
        state.broadcasts = 0
      }
    })
  },
})

export const transactionsActions = slice.actions
export default slice.reducer
