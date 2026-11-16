import { createSlice, Slice } from '@reduxjs/toolkit'
import {
  Account,
  AddressSummary,
  QbitBalanceSummary,
  TxHistoryItem,
} from '@qbit/wallet-shared'

import { resetWalletState, updateVersion } from '../actions/global'

export interface Molels {
  states: boolean
}

export interface BalanceRefreshStatus {
  requestId: number
  error: boolean
  /**
   * The refresh whose balance balanceV2Map holds, once one is stored. Only a
   * newer balance replaces it, and a newer failure does not; an older one
   * does only to put a split in place of an answer that could not read every
   * output (see `setBalanceV2`).
   */
  balanceRequestId?: number
}

function isStaleBalanceRequest(state: AccountsState, address: string, requestId?: number): boolean {
  const latest = state.balanceStatusMap[address]
  return requestId !== undefined && latest !== undefined && requestId < latest.requestId
}

/**
 * Records that the refresh `requestId` failed, unless a newer refresh has
 * already settled. The last known-good balance, if any, stays in
 * balanceV2Map.
 */
function recordBalanceFailure(state: AccountsState, address: string, requestId: number): void {
  if (isStaleBalanceRequest(state, address, requestId)) return
  state.balanceStatusMap[address] = {
    ...state.balanceStatusMap[address],
    requestId,
    error: true,
  }
}

/**
 * Whether `balance` has a split: its Available is known, and it is not an
 * answer that could not read every output. A total alone (past the
 * explorer's limit with no split, or while the send guard held) has none.
 */
function hasBalanceSplit(balance: QbitBalanceSummary | undefined): boolean {
  return typeof balance?.availableBalance === 'number' && balance.utxoReadIncomplete !== true
}

/**
 * Whether the balance stored for `address` has a split a read measured on
 * `chainType`: a read for that network stored it, and it has a split.
 */
function hasKnownBalanceSplit(state: AccountsState, address: string, chainType: string): boolean {
  return (
    hasAccountBalanceRead(state, address, chainType) && hasBalanceSplit(state.balanceV2Map[address])
  )
}

/**
 * Whether the balance stored for `address` is an answer read on `chainType`
 * that could not read every output: stored for its total, as no split for
 * that network was known when it arrived.
 */
function hasIncompleteBalance(state: AccountsState, address: string, chainType: string): boolean {
  return (
    hasAccountBalanceRead(state, address, chainType) &&
    state.balanceV2Map[address]?.utxoReadIncomplete === true
  )
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
   * of a newer one, or a newer balance. An older balance that arrives after a
   * newer refresh failed is still the newest balance read: it is stored, and
   * the failure stays the outcome. An answer that could not read every
   * output is such a failure wherever a split for its network was read,
   * before or after it (see `setBalanceV2`).
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
            utxoReadIncomplete,
            chainType,
          },
          address,
          requestId,
        },
      } = action
      const latest = state.balanceStatusMap[address]
      if (
        requestId !== undefined &&
        latest?.balanceRequestId !== undefined &&
        requestId < latest.balanceRequestId
      ) {
        // Older than the balance stored, it replaces nothing, except where
        // the stored balance is an answer that could not read every output
        // and this one has the split for its network. Then it is the newest
        // split read, and lands as an older balance does after a newer
        // failure: it is stored, and the newer read stays the outcome, now
        // as a failed refresh. The store ends as it would have had the two
        // arrived in order.
        if (
          !hasBalanceSplit(action.payload.balance) ||
          !hasIncompleteBalance(state, address, chainType)
        ) {
          return
        }
        latest.balanceRequestId = requestId
        latest.error = true
      } else if (utxoReadIncomplete === true && hasKnownBalanceSplit(state, address, chainType)) {
        // An answer that could not read every output, where a split is
        // already stored for this account on this network, replaces nothing:
        // it is recorded as a refresh that failed, under the same ordering,
        // so the split stays, marked out of date, and nothing of the answer
        // is kept. Only where no split is known (the first read, or a total
        // alone) is it stored, for its total, until a split arrives.
        recordBalanceFailure(state, address, requestId ?? latest?.requestId ?? 0)
        return
      } else if (latest !== undefined && isStaleBalanceRequest(state, address, requestId)) {
        // A newer refresh failed first: keep its failure as the outcome.
        latest.balanceRequestId = requestId
      } else {
        const outcomeRequestId = requestId ?? latest?.requestId ?? 0
        state.balanceStatusMap[address] = {
          requestId: outcomeRequestId,
          error: false,
          balanceRequestId: outcomeRequestId,
        }
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
      state.balanceV2Map[address].utxoReadIncomplete = utxoReadIncomplete
      state.balanceV2Map[address].chainType = chainType
    },
    setBalanceError(state, action: { payload: { address: string; requestId: number } }) {
      const { address, requestId } = action.payload
      recordBalanceFailure(state, address, requestId)
    },
    setAddressSummary(state, action: { payload: any }) {
      state.addressSummary = action.payload
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
    builder.addCase(resetWalletState, () => initialState)
  },
})

export const accountActions = slice.actions
export default slice.reducer

/**
 * Whether a balance read for `address` on `chainType` has succeeded: only a
 * successful read stores one. Until then `useAccountBalance` stands in
 * zeros, which are no measurement and show as unknown (`--`), unlike a 0 a
 * read returned.
 */
export function hasAccountBalanceRead(
  state: AccountsState,
  address: string,
  chainType: string
): boolean {
  return state.balanceV2Map[address]?.chainType === chainType
}
