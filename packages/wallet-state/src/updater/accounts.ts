import { useCallback, useEffect, useRef } from 'react'
import { useStore } from 'react-redux'

import { Account, BUS_METHODS } from '@qbit/wallet-shared'
import type { AppState } from '..'
import { uiEventBus } from '../utils/eventBus'

import { useIsUnlocked } from '../hooks/global'
import { globalActions } from '../reducers/global'
import { useAppDispatch } from '../hooks/base'
import { settingsActions } from '../reducers/settings'
import {
  newestBalanceRequestId,
  useCurrentAccount,
  useReloadAccounts,
  useStartBalanceReadCallback,
} from '../hooks/accounts'
import { accountActions, accountsReloaded, balanceReadsLocked } from '../reducers/accounts'
import { ChainType } from '@qbit/wallet-types'
import { useWallet } from '../context/WalletContext'
import { balanceCardFor, balanceCardWaiting, balanceReadInFlight } from '../hooks/balanceReads'

export function AccountUpdater() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  const currentAccount = useCurrentAccount()
  const isUnlocked = useIsUnlocked()
  const store = useStore()
  const selfRef = useRef({
    preAccountKey: '_',
    loadingHistory: false,
  })
  const self = selfRef.current

  const reloadAccounts = useReloadAccounts()
  const onCurrentChange = useCallback(async () => {
    if (isUnlocked && currentAccount && currentAccount.key != self.preAccountKey) {
      self.preAccountKey = currentAccount.key

      // setLoading(true);

      reloadAccounts()

      // setLoading(false);
    }
  }, [dispatch, currentAccount, wallet, isUnlocked])

  useEffect(() => {
    onCurrentChange()
  }, [currentAccount && currentAccount.key, isUnlocked])

  const startRead = useStartBalanceReadCallback()
  // The accounts the page starts with are its first network's: so a network
  // switch before any reload of them has ended is told as one, and the
  // balance card waits for the new network's account (`accountsLoaded`).
  useEffect(() => {
    if (!isUnlocked || !currentAccount.address) return
    const { accounts, settings } = store.getState() as AppState
    if (accounts.accountsLoaded !== undefined) return
    dispatch(accountsReloaded({ chainType: settings.chainType, seq: 0 }))
  }, [dispatch, store, isUnlocked, currentAccount.address])
  // The newest read this page had begun when the wallet last locked.
  const lockedAfterRef = useRef(0)
  useEffect(() => {
    // Whatever this page read before a lock may be out of date once the
    // wallet is unlocked again (the background forgot what it kept): it shows
    // as being refreshed until a read begun after the unlock answers.
    if (!isUnlocked) {
      lockedAfterRef.current = newestBalanceRequestId()
      dispatch(balanceReadsLocked({ before: lockedAfterRef.current }))
    }
  }, [dispatch, isUnlocked])

  useEffect(() => {
    // A newly selected account, or the wallet unlocked, reads at once, every
    // screen alike. One read of the account at a time: none while one of
    // this page's reads of it is in flight, whoever began it. While the
    // balance card shows the account the read is the card's, through its
    // poll, so its outcome paces the card's next read; a card shown while
    // this read is in flight takes it as its own (see `pageBalanceReads`).
    // A read still in flight from before the last lock is not this read: its
    // answer is out of date (`balanceReadsLocked`), so a new one begins.
    const address = currentAccount.address
    if (!isUnlocked || !address) return
    // Nothing while the balance card waits for the selected account to be
    // the new network's: it is still the previous network's.
    if (balanceCardWaiting(store, address)) return
    const inFlight = balanceReadInFlight(store, address)
    if (inFlight && inFlight.requestId > lockedAfterRef.current) return
    const card = balanceCardFor(store, address)
    const reading = card ? card.read() : startRead()
    reading.catch(() => {
      // Recorded in the store; the balance card shows it as its status says.
    })
  }, [startRead, wallet, isUnlocked, store, currentAccount.address])

  useEffect(() => {
    const accountChangeHandler = (account: Account) => {
      if (account && account.address) {
        dispatch((accountActions as any).setCurrent(account))
      }
    }
    uiEventBus.addEventListener(BUS_METHODS.ACCOUNTS_CHANGED, accountChangeHandler)
    return () => {
      uiEventBus.removeEventListener(BUS_METHODS.ACCOUNTS_CHANGED, accountChangeHandler)
    }
  }, [dispatch])

  useEffect(() => {
    const chaintChangeHandler = (params: { type: ChainType }) => {
      dispatch(
        (settingsActions as any).updateSettings({
          chainType: params.type,
        })
      )

      reloadAccounts()
    }
    uiEventBus.addEventListener(BUS_METHODS.CHAIN_CHANGED, chaintChangeHandler)
    return () => {
      uiEventBus.removeEventListener(BUS_METHODS.CHAIN_CHANGED, chaintChangeHandler)
    }
  }, [dispatch])

  useEffect(() => {
    // Layout sends a locked page to the unlock screen once the store knows the
    // wallet has a vault (isBooted), which the page reads only as it loads. A
    // page that loaded before the wallet was created would never know, so
    // every lock asks again, after marking the page locked: a page that knew
    // does not wait for the answer. Only a vault found is published. That is
    // safe while nothing removes the vault under a page that stays loaded
    // (anything that ever does must reload the pages): a late answer then
    // cannot undo a newer one. It leaves isUnlocked alone, so an unlock that
    // came first stays. A failed read changes nothing; the next lock reads
    // again.
    let mounted = true
    const publishVault = async (): Promise<void> => {
      try {
        // Not after unmount: a read still in flight then publishes nothing.
        if ((await wallet.hasVault()) && mounted) {
          dispatch(globalActions.update({ isBooted: true }))
        }
      } catch {
        // Nothing to publish.
      }
    }
    const lockHandler = () => {
      dispatch(globalActions.update({ isUnlocked: false }))
      publishVault()
    }
    uiEventBus.addEventListener(BUS_METHODS.LOCKED, lockHandler)
    return () => {
      mounted = false
      uiEventBus.removeEventListener(BUS_METHODS.LOCKED, lockHandler)
    }
  }, [dispatch, wallet])

  useEffect(() => {
    const unlockHandler = () => {
      dispatch(globalActions.update({ isUnlocked: true }))
    }
    uiEventBus.addEventListener(BUS_METHODS.UNLOCKED, unlockHandler)
    return () => {
      uiEventBus.removeEventListener(BUS_METHODS.UNLOCKED, unlockHandler)
    }
  }, [dispatch])

  return null
}
