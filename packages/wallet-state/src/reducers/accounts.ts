import { createSlice, Slice } from '@reduxjs/toolkit'
import {
  Account,
  AddressSummary,
  QbitBalanceSummary,
  TxHistoryItem,
} from '@qbit/wallet-shared'

import { updateVersion } from '../actions/global'

export interface Molels {
  states: boolean
}

export interface MolelsPopover {
  state: boolean
  title: string
  data: any
}

export interface BalanceRefreshStatus {
  requestId: number
  error: boolean
}

function isStaleBalanceRequest(state: AccountsState, address: string, requestId?: number): boolean {
  const latest = state.balanceStatusMap[address]
  return requestId !== undefined && latest !== undefined && requestId < latest.requestId
}

export interface AccountsState {
  accounts: Account[]
  current: Account
  loading: boolean
  balanceV2Map: {
    [key: string]: QbitBalanceSummary
  }
  /**
   * Outcome of the latest balance refresh per address. On `error` the
   * balanceV2Map entry, if any, is the last known-good balance. `requestId`
   * orders refreshes so a slower, older response cannot replace the outcome
   * of a newer one.
   */
  balanceStatusMap: {
    [key: string]: BalanceRefreshStatus
  }
  historyMap: {
    [key: string]: {
      list: TxHistoryItem[]
      expired: boolean
      /** Absent only in state written before history totals were retained. */
      total?: number
      /** Txids from the remote first page paired with the stored total. */
      firstPageTxids?: string[]
      /** Carried pending txids verified by the node to still be in the API total. */
      verifiedPendingTxids?: string[]
      /** Opaque background snapshot used to keep later Qbit pages stable. */
      snapshotId?: string
      /** The last refresh failed; the last known-good list remains intact. */
      error?: boolean
    }
  }
  addressSummary: AddressSummary
  model: Molels
  molelsPopover: MolelsPopover
}

const initialAccount = {
  type: '',
  address: '',
  brandName: '',
  alianName: '',
  displayBrandName: '',
  index: 0,
  balance: 0,
  pubkey: '',
  key: '',
  flag: 0,
}

export const initialState: AccountsState = {
  accounts: [],
  current: initialAccount,
  loading: false,
  balanceV2Map: {},
  balanceStatusMap: {},
  historyMap: {},
  addressSummary: {
    totalSatoshis: 0,
    spendableSatoshis: 0,
    loading: true,
    address: '',
  },

  model: { states: false },
  molelsPopover: { state: false, title: '', data: null },
}

const slice: Slice<AccountsState> = createSlice({
  name: 'accounts',
  initialState,
  reducers: {
    pendingLogin(state) {
      state.loading = true
    },
    setCurrent(state, action: { payload: Account }) {
      const { payload } = action
      state.current = payload || initialAccount
    },
    setAccounts(state, action: { payload: Account[] }) {
      const { payload } = action
      state.accounts = payload
    },
    setBalanceV2(
      state,
      action: {
        payload: {
          address: string
          balance: QbitBalanceSummary
          /** Orders this result against other refreshes; see balanceStatusMap. */
          requestId?: number
        }
      }
    ) {
      const {
        payload: {
          balance: {
            availableBalance,
            unavailableBalance,
            totalBalance,
            immatureBalance,
            pendingBalance,
            utxoLimitExceeded,
            chainType,
          },
          address,
          requestId,
        },
      } = action
      if (isStaleBalanceRequest(state, address, requestId)) return
      state.balanceStatusMap[address] = {
        requestId: requestId ?? state.balanceStatusMap[address]?.requestId ?? 0,
        error: false,
      }
      state.balanceV2Map[address] = state.balanceV2Map[address] || {
        availableBalance: 0,
        unavailableBalance: 0,
        totalBalance: 0,
        chainType,
      }
      state.balanceV2Map[address].availableBalance = availableBalance
      state.balanceV2Map[address].unavailableBalance = unavailableBalance
      state.balanceV2Map[address].totalBalance = totalBalance
      state.balanceV2Map[address].immatureBalance = immatureBalance
      state.balanceV2Map[address].pendingBalance = pendingBalance
      state.balanceV2Map[address].utxoLimitExceeded = utxoLimitExceeded
      state.balanceV2Map[address].chainType = chainType
    },
    setBalanceError(state, action: { payload: { address: string; requestId: number } }) {
      const { address, requestId } = action.payload
      if (isStaleBalanceRequest(state, address, requestId)) return
      // The last known-good balance, if any, stays in balanceV2Map.
      state.balanceStatusMap[address] = { requestId, error: true }
    },
    setAddressSummary(state, action: { payload: any }) {
      state.addressSummary = action.payload
    },
    setModelPopover(state, action: { payload: MolelsPopover }) {
      state.molelsPopover = action.payload
    },
    setHistory(
      state,
      action: {
        payload: {
          address: string
          list: TxHistoryItem[]
          total?: number
          firstPageTxids?: string[]
          verifiedPendingTxids?: string[]
          snapshotId?: string
        }
      }
    ) {
      const {
        payload: { address, list, total, firstPageTxids, verifiedPendingTxids, snapshotId },
      } = action
      state.historyMap[address] = state.historyMap[address] || {
        list: [],
        expired: true,
        total: 0,
      }
      state.historyMap[address].list = list
      state.historyMap[address].firstPageTxids = firstPageTxids
      state.historyMap[address].verifiedPendingTxids = verifiedPendingTxids
      state.historyMap[address].snapshotId = snapshotId
      state.historyMap[address].error = false
      if (total !== undefined) {
        state.historyMap[address].total = total
      }
      state.historyMap[address].expired = false
    },
    setHistoryError(state, action: { payload: { address: string } }) {
      const { address } = action.payload
      state.historyMap[address] = state.historyMap[address] || {
        list: [],
        expired: true,
        total: 0,
      }
      state.historyMap[address].error = true
    },
    expireHistory(state, action: { payload?: string }) {
      const history = state.historyMap[action.payload ?? state.current.address]
      if (history) {
        history.expired = true
      }
    },
    setCurrentAccountName(state, action: { payload: string }) {
      const { payload } = action
      state.current.alianName = payload
      const account = state.accounts.find(v => v.address === state.current.address)
      if (account) {
        account.alianName = payload
      }
    },
    setCurrentAddressFlag(state, action: { payload: number }) {
      const { payload } = action
      state.current.flag = payload
      const account = state.accounts.find(v => v.address === state.current.address)
      if (account) {
        account.flag = payload
      }
    },
    rejectLogin(state) {
      state.loading = false
    },
    reset(state) {
      return initialState
    },
    updateAccountName(
      state,
      action: {
        payload: Account
      }
    ) {
      const account = action.payload
      if (state.current.key === account.key) {
        state.current.alianName = account.alianName!
      }
      state.accounts.forEach(v => {
        if (v.key === account.key) {
          v.alianName = account.alianName!
        }
      })
    },
  },
  extraReducers: builder => {
    builder.addCase(updateVersion, state => {
      // todo
      if (!state.addressSummary) {
        state.addressSummary = {
          totalSatoshis: 0,
          spendableSatoshis: 0,
          loading: true,
          address: '',
        }
      }

      if (!state.balanceV2Map) {
        state.balanceV2Map = {}
      }

      if (!state.balanceStatusMap) {
        state.balanceStatusMap = {}
      }
    })
  },
})

export const accountActions = slice.actions
export default slice.reducer
