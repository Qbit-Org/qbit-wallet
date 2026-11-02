import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useStore } from 'react-redux'

import {
  Account,
  KeyringType,
  canCreateQbitSendRequest,
  getAccountCapabilities,
} from '@qbit/wallet-shared'


import { AppState } from '..'
import { useWallet } from '../context/WalletContext'
import { accountActions } from '../reducers/accounts'
import {
  buildHistoryList,
  detectReplacedCandidates,
  resolveReplacedCandidates,
} from '../utils/history-utils'
import { keyringsActions } from '../reducers/keyrings'
import { settingsActions } from '../reducers/settings'
import { useAppDispatch, useAppSelector } from './base'

export function useAccountsState(): AppState['accounts'] {
  return useAppSelector(state => state.accounts)
}

export function useCurrentAccount() {
  const accountsState = useAccountsState()
  return accountsState.current
}

export function useCurrentAddress() {
  const accountsState = useAccountsState()
  return accountsState.current.address
}

export function useCurrentAccountCapabilities() {
  const currentAccount = useCurrentAccount()
  return useMemo(() => getAccountCapabilities(currentAccount), [currentAccount])
}

export function useCanCreateQbitSendRequest() {
  const currentAccount = useCurrentAccount()
  return useMemo(() => canCreateQbitSendRequest(currentAccount), [currentAccount])
}

export function useAccounts() {
  const accountsState = useAccountsState()
  return accountsState.accounts
}

export function useAccountBalance() {
  const accountsState = useAccountsState()
  const currentAccount = useCurrentAccount()
  const chainType = useAppSelector(state => state.settings.chainType)
  return (
    accountsState.balanceV2Map[currentAccount.address] || {
      availableBalance: 0,
      unavailableBalance: 0,
      totalBalance: 0,
      chainType,
    }
  )
}

/**
 * Whether the current account has a balance from the explorer yet, and
 * whether its latest refresh failed (the balance, if any, is then stale).
 */
export function useAccountBalanceStatus() {
  const accountsState = useAccountsState()
  const currentAccount = useCurrentAccount()
  return {
    loaded: accountsState.balanceV2Map[currentAccount.address] !== undefined,
    error: accountsState.balanceStatusMap[currentAccount.address]?.error === true,
  }
}

export function useAddressSummary() {
  const accountsState = useAccountsState()
  return accountsState.addressSummary
}

export function useHistory() {
  const accountsState = useAccountsState()
  const historyScopeKey = useHistoryScopeKey()
  return (
    accountsState.historyMap[historyScopeKey] || {
      list: [],
      expired: true,
      total: 0,
      firstPageTxids: undefined,
      verifiedPendingTxids: undefined,
      snapshotId: undefined,
      error: false,
    }
  )
}

/**
 * The key history is stored under: the selected account's own public key on
 * the current network, as the background keys it (`getAddressHistory`
 * returns it as `scopeKey`). The `qbit-account:` prefix never matches the
 * `qbit:` keys earlier builds used for one history of every account.
 */
function selectHistoryScopeKey(state: AppState): string {
  const currentAccount = state.accounts.current
  const currentKeyring = state.keyrings.current
  if (
    currentAccount.type === KeyringType.QbitHdKeyring &&
    currentKeyring.type === KeyringType.QbitHdKeyring &&
    currentAccount.pubkey
  ) {
    return `qbit-account:${state.settings.chainType}:${currentAccount.pubkey.toLowerCase()}`
  }
  return currentAccount.address
}

export function useHistoryScopeKey(): string {
  return useAppSelector(selectHistoryScopeKey)
}

export function useAccountAddress() {
  const currentAccount = useCurrentAccount()
  return currentAccount.address
}

export function useSetCurrentAccountCallback() {
  const dispatch = useAppDispatch()
  return useCallback(
    (account: Account) => {
      dispatch(accountActions['setCurrent']!(account))
    },
    [dispatch]
  )
}

export function useChangeAddressFlagCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  const currentAccount = useCurrentAccount()
  return useCallback(
    async (isAdd: boolean, flag: number) => {
      const account = isAdd
        ? await wallet.addAddressFlag(currentAccount, flag)
        : await wallet.removeAddressFlag(currentAccount, flag)
      dispatch(accountActions['setCurrentAddressFlag']!(account.flag))
    },
    [dispatch, wallet, currentAccount]
  )
}

const HISTORY_FIRST_PAGE_SIZE = 20

export function useFetchHistoryCallback() {
  const dispatch = useAppDispatch()
  const store = useStore<AppState>()
  const wallet = useWallet()
  const address = useAccountAddress()
  const historyScopeKey = useHistoryScopeKey()
  const history = useHistory()
  const historyRef = useRef(history)
  historyRef.current = history
  const generationRef = useRef(0)
  const probeCursorRef = useRef({ scopeKey: historyScopeKey, index: 0 })
  return useCallback(async () => {
    if (!address) return
    const generation = ++generationRef.current
    const probeStartIndex =
      probeCursorRef.current.scopeKey === historyScopeKey ? probeCursorRef.current.index : 0
    try {
      const previousHistory = historyRef.current
      const previous = previousHistory?.list ?? []
      const previouslyVerifiedPendingTxids = new Set(previousHistory?.verifiedPendingTxids ?? [])
      const _accountHistory = await wallet.getAddressHistory({
        address,
        start: 0,
        limit: HISTORY_FIRST_PAGE_SIZE,
        ...(historyRef.current?.snapshotId
          ? { refreshSnapshotId: historyRef.current.snapshotId }
          : {}),
      })
      if (_accountHistory.scopeKey !== undefined && _accountHistory.scopeKey !== historyScopeKey) {
        return
      }
      const fresh = _accountHistory.detail
      // A vanished pending tx is only branded replaced after the node confirms
      // it no longer knows it; confirmed-beyond-the-page txs are left alone.
      // Probes run through a bounded budget and worker pool so a large
      // retained pending set cannot flood the explorer each poll. The window
      // rotates via a cursor so candidates past the budget are not starved.
      const candidates = detectReplacedCandidates(previous, fresh)
      const resolutions = await resolveReplacedCandidates(
        candidates,
        txid => wallet.getQbitTxLifecycleStatus(txid),
        { startIndex: probeStartIndex }
      )
      // A slower, older fetch must not advance the shared probe window.
      if (generation !== generationRef.current) return
      probeCursorRef.current = {
        scopeKey: historyScopeKey,
        index:
          candidates.length > 0
            ? (probeStartIndex + resolutions.length) % candidates.length
            : 0,
      }
      const list = buildHistoryList(previous, fresh, resolutions)
      const freshTxids = new Set(fresh.map(item => item.txid))
      const resolutionByTxid = new Map(resolutions.map(item => [item.txid, item]))
      const verifiedPendingTxids: string[] = []
      const seenVerifiedPendingTxids = new Set<string>()
      for (const item of list) {
        if (
          item.confirmations !== 0 ||
          item.replaced ||
          freshTxids.has(item.txid) ||
          seenVerifiedPendingTxids.has(item.txid)
        ) {
          continue
        }
        const resolution = resolutionByTxid.get(item.txid)
        const verifiedThisRefresh = resolution?.verified && resolution.state === 'pending'
        const preservedFromPrevious =
          resolution === undefined && previouslyVerifiedPendingTxids.has(item.txid)
        if (verifiedThisRefresh || preservedFromPrevious) {
          seenVerifiedPendingTxids.add(item.txid)
          verifiedPendingTxids.push(item.txid)
        }
      }
      dispatch(
        accountActions['setHistory']!({
          address: historyScopeKey,
          list,
          total: _accountHistory.total,
          firstPageTxids: fresh.map(item => item.txid),
          verifiedPendingTxids,
          snapshotId: _accountHistory.snapshotId,
        })
      )
    } catch (error) {
      // The background refuses a read whose account is no longer selected.
      // That says nothing about this account's history, so only a failure
      // for the account still selected is recorded against it.
      if (
        generation === generationRef.current &&
        selectHistoryScopeKey(store.getState()) === historyScopeKey
      ) {
        dispatch(accountActions['setHistoryError']!({ address: historyScopeKey }))
      }
      throw error
    }
  }, [dispatch, store, wallet, address, historyScopeKey])
}

/**
 * Refetch the selected account's first history page on mount and on an interval
 * while mounted. The 60s default matches the qbit block cadence, so
 * confirmation counts, reorg flips and replaced (RBF) txs surface within one
 * block. Returns the same generation-guarded callback used by the poller so
 * manual refreshes cannot race it with an independent request generation.
 */
export function useHistoryAutoRefresh(intervalMs = 60_000) {
  const fetchHistory = useFetchHistoryCallback()
  useEffect(() => {
    let inFlight = false
    const refresh = () => {
      if (inFlight) return
      inFlight = true
      fetchHistory()
        .catch(() => {
          // A failed poll keeps the last known history; the next tick retries.
        })
        .finally(() => {
          inFlight = false
        })
    }
    refresh()
    const timer = setInterval(refresh, intervalMs)
    return () => {
      clearInterval(timer)
    }
  }, [fetchHistory, intervalMs])
  return fetchHistory
}

// Shared by every fetchBalance instance (updater, balance card, post-broadcast
// refreshes) so the reducer can order their overlapping responses.
let lastBalanceRequestId = 0

export function useFetchBalanceCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  const currentAccount = useCurrentAccount()
  const { address } = currentAccount
  return useCallback(async () => {
    if (!address) return
    const requestId = ++lastBalanceRequestId
    try {
      const summary = await wallet.getAddressSummary(address)
      dispatch(accountActions['setAddressSummary']!({ ...summary, address }))

      const balanceV2 = await wallet.getAddressBalanceV2(address)
      dispatch(
        accountActions['setBalanceV2']!({
          address,
          balance: balanceV2,
          chainType: balanceV2.chainType,
          requestId,
        })
      )
    } catch (error) {
      dispatch(accountActions['setBalanceError']!({ address, requestId }))
      throw error
    }
  }, [dispatch, wallet, address])
}

export function useReloadAccounts() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(async () => {
    const keyrings = await wallet.getKeyrings()
    dispatch(keyringsActions['setKeyrings']!(keyrings))

    const currentKeyring = await wallet.getCurrentKeyring()
    dispatch(keyringsActions['setCurrent']!(currentKeyring))

    const _accounts = await wallet.getAccounts()
    dispatch(accountActions['setAccounts']!(_accounts))

    const account = await wallet.getCurrentAccount()
    dispatch(accountActions['setCurrent']!(account))

    wallet.getWalletConfig().then(data => {
      dispatch(settingsActions['updateSettings']!({ walletConfig: data }))
    })
  }, [dispatch, wallet])
}

export function useModelPopover() {
  const modelState = useAccountsState()
  return modelState.molelsPopover
}
