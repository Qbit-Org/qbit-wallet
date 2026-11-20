import { QbitUtxoSnapshot, UnspentOutput } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { createSlice, Slice } from '@reduxjs/toolkit'

import { resetWalletState } from '../actions/global'

export interface TransactionsState {
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
}

export const initialState: TransactionsState = {
  utxos: [],
  utxosChain: null,
  utxosAddress: null,
  utxosRead: 0,
}

const slice: Slice<TransactionsState> = createSlice({
  name: 'transactions',
  initialState,
  reducers: {
    setUtxos(state, action: { payload: QbitUtxoSnapshot & { read?: number } }) {
      state.utxos = action.payload.utxos
      state.utxosChain = action.payload.chain
      state.utxosAddress = action.payload.address
      state.utxosRead = action.payload.read ?? 0
    },
    reset(state) {
      return initialState
    },
  },

  extraReducers: builder => {
    builder.addCase(resetWalletState, () => initialState)
  },
})

export const transactionsActions = slice.actions
export default slice.reducer
