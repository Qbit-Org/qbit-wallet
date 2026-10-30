import { useCallback, useEffect, useRef } from 'react'

import { Account, BUS_METHODS } from '@qbit/wallet-shared'
import { uiEventBus } from '../utils/eventBus'

import { useIsUnlocked } from '../hooks/global'
import { globalActions } from '../reducers/global'
import { useAppDispatch } from '../hooks/base'
import { settingsActions } from '../reducers/settings'
import { useCurrentAccount, useFetchBalanceCallback, useReloadAccounts } from '../hooks/accounts'
import { accountActions } from '../reducers/accounts'
import { ChainType } from '@qbit/wallet-types'
import { useWallet } from '../context/WalletContext'

export function AccountUpdater() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  const currentAccount = useCurrentAccount()
  const isUnlocked = useIsUnlocked()
  const selfRef = useRef({
    preAccountKey: '_',
    balanceFetch: undefined as { address: string } | undefined,
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

  const fetchBalance = useFetchBalanceCallback()
  useEffect(() => {
    // Skip a second fetch for the account already loading, but not for a newly
    // selected one: it loads at once instead of on the balance card's next poll.
    // Outcomes are recorded per address, so the two fetches cannot clash.
    const address = currentAccount.address
    if (self.balanceFetch?.address === address) {
      return
    }
    if (!isUnlocked) {
      return
    }
    // Only this fetch clears the marker: an older fetch for the same account
    // settling must not, while this one is still in flight.
    const balanceFetch = { address }
    self.balanceFetch = balanceFetch
    fetchBalance()
      .catch(() => {
        // Recorded in balanceStatusMap; the balance card shows it with a retry.
      })
      .finally(() => {
        if (self.balanceFetch === balanceFetch) {
          self.balanceFetch = undefined
        }
      })
  }, [fetchBalance, wallet, isUnlocked, self, currentAccount.address])

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
    const lockHandler = () => {
      dispatch(globalActions.update({ isUnlocked: false }))
    }
    uiEventBus.addEventListener(BUS_METHODS.LOCKED, lockHandler)
    return () => {
      uiEventBus.removeEventListener(BUS_METHODS.LOCKED, lockHandler)
    }
  }, [dispatch])

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
