import { createAction, createSlice, Slice } from '@reduxjs/toolkit'
import { Account, AddressSummary, QbitBalanceSummary, TxHistoryItem } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'

import { resetWalletState, updateVersion } from '../actions/global'

export interface Molels {
  states: boolean
}

/**
 * An account's total as the account switcher last showed it on one network,
 * kept for the page's lifetime so that the switcher, opened again, shows it
 * at once while the background is asked again.
 */
export interface AccountTotalEntry {
  /** In sats; `null` when no answer has carried one. */
  totalBalance: number | null
  /** When the background measured that total, in ms since the epoch. */
  readAt: number | null
  /**
   * `totalBalance` may not be the account's total now: the latest answer
   * for the account measured none on this network (its read failed,
   * answered none, or answered for another network), so it is an earlier
   * one, or the read says it may be from before a transaction the wallet
   * submitted. An answer that is not settled (a kept total to be read
   * again) does not clear it: only a settled one does.
   */
  stale: boolean
  /**
   * No other answer is to come for the request that stored it: a read's
   * answer or failure, or a kept total fresh enough not to be read again. A
   * kept total that is to be read again is not settled.
   */
  settled: boolean
  /** The request the latest answer stored here answered; see `storeAccountTotals`. */
  requestId: number
}

/** One answer of the account switcher's requests, as `storeAccountTotals` stores it. */
export interface AccountTotalUpdate {
  address: string
  /** The network it is stored under. */
  chainType: ChainType
  /** The request it answers; request ids grow with every request a page makes. */
  requestId: number
  /** In sats, or `null` when the answer measured none. */
  totalBalance: number | null
  readAt: number | null
  /**
   * The total may not be current: the latest read failed, or it may be from
   * before a transaction the wallet submitted. See `AccountTotalEntry.stale`.
   */
  stale: boolean
  /** See `AccountTotalEntry.settled`. */
  settled: boolean
}

const CHAIN_TYPES: ReadonlySet<string> = new Set(Object.values(ChainType))

/** Whether `value` names one of the wallet's networks. */
export function isChainType(value: unknown): value is ChainType {
  return typeof value === 'string' && CHAIN_TYPES.has(value)
}

/** Whether `value` is a number of sats: a safe integer, 0 or more. */
export function isSatoshiAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Stores `update`, unless its request was made before the latest reset or an
 * answer of a newer request is stored already. An answer without a total
 * keeps the total stored before it, marked as stale. An answer that is not
 * settled, a kept total that is to be read again, vouches for nothing: it
 * keeps a stale mark stored before it, so the total stays stale until a
 * settled answer (a read's, or a fresh kept total) says otherwise. The
 * addresses of each network are kept in an object without a prototype, so
 * that no address, whatever it is, can reach a built-in.
 */
function storeAccountTotal(state: AccountsState, update: AccountTotalUpdate): void {
  const { address, chainType, requestId } = update
  if (!isChainType(chainType) || typeof address !== 'string' || address === '') return
  if (typeof requestId !== 'number' || requestId <= state.accountTotalsFloor) return
  let totals = state.accountTotalsMap[chainType]
  if (totals === undefined) {
    totals = Object.create(null) as Record<string, AccountTotalEntry>
    state.accountTotalsMap[chainType] = totals
  }
  const stored = totals[address]
  if (stored !== undefined && requestId < stored.requestId) return
  if (isSatoshiAmount(update.totalBalance)) {
    const settled = update.settled === true
    totals[address] = {
      totalBalance: update.totalBalance,
      readAt: typeof update.readAt === 'number' ? update.readAt : null,
      stale: update.stale === true || (!settled && stored?.stale === true),
      settled,
      requestId,
    }
    return
  }
  totals[address] = {
    totalBalance: stored?.totalBalance ?? null,
    readAt: stored?.readAt ?? null,
    stale: true,
    settled: update.settled === true,
    requestId,
  }
}

/**
 * Answers of the account switcher's requests, stored together (see
 * `storeAccountTotal`). Answers that arrive close together come in one
 * action, so that a page shows them in one update.
 */
export const storeAccountTotals = createAction<AccountTotalUpdate[]>('accounts/storeAccountTotals')

/**
 * The account switcher made the requests up to `requestId`. A reset drops
 * the answers of every request made before it, so a total read for an erased
 * wallet never comes back.
 */
export const accountTotalsAsked = createAction<number>('accounts/accountTotalsAsked')

/**
 * The state a reset leaves: the initial one, except that the answers of the
 * requests made before it are dropped when they arrive.
 */
function resetAccounts(state: AccountsState): AccountsState {
  return {
    ...initialState,
    accountTotalsFloor: state.accountTotalsAsked,
    accountTotalsAsked: state.accountTotalsAsked,
  }
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
  /**
   * The account switcher's totals, per network and then per address, from
   * the background's answers (`storeAccountTotals`). Like the rest of this
   * slice, never saved.
   */
  accountTotalsMap: {
    [chainType: string]: { [address: string]: AccountTotalEntry }
  }
  /** The latest request the account switcher made (`accountTotalsAsked`). */
  accountTotalsAsked: number
  /** Answers of requests up to this one, made before the latest reset, are dropped. */
  accountTotalsFloor: number
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
  accountTotalsMap: {},
  accountTotalsAsked: 0,
  accountTotalsFloor: 0,
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
      return resetAccounts(state)
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

      if (!state.accountTotalsMap) {
        state.accountTotalsMap = {}
      }

      if (typeof state.accountTotalsAsked !== 'number') {
        state.accountTotalsAsked = 0
      }

      if (typeof state.accountTotalsFloor !== 'number') {
        state.accountTotalsFloor = 0
      }
    })
    builder.addCase(storeAccountTotals, (state, action) => {
      for (const update of action.payload) storeAccountTotal(state, update)
    })
    builder.addCase(accountTotalsAsked, (state, action) => {
      if (typeof action.payload === 'number' && action.payload > state.accountTotalsAsked) {
        state.accountTotalsAsked = action.payload
      }
    })
    builder.addCase(resetWalletState, state => resetAccounts(state))
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
