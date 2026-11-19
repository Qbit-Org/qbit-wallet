import { useCallback } from 'react'

import { QbitResetWalletOptions, QbitRestoreReport } from '@qbit/wallet-shared'
import { AddressType } from '@qbit/wallet-types'

import { AppState } from '..'
import { useWallet } from '../context/WalletContext'
import { globalActions } from '../reducers/global'
import { useAppDispatch, useAppSelector } from './base'

export function useGlobalState(): AppState['global'] {
  return useAppSelector(state => state.global)
}

export function useBooted() {
  const globalState = useGlobalState()
  return globalState.isBooted
}

export function useIsUnlocked() {
  const globalState = useGlobalState()
  return globalState.isUnlocked
}

export function useIsReady() {
  const globalState = useGlobalState()
  return globalState.isReady
}

export function useSwitchChainModalVisible() {
  const globalState = useGlobalState()
  return globalState.switchChainModalVisible
}

export function useUnlockCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(
    async (password: string) => {
      await wallet.unlock(password)
      dispatch(globalActions.update({ isUnlocked: true }))
      // Unlocking answers only the provider's unlock request ({ lock: true }),
      // which the background checks and resolves in one step. Any other
      // pending approval (Connect, SwitchChain, ...) outlived a lock and still
      // needs an explicit decision; the caller routes back to it once this
      // returns. A failed call leaves the request pending for that route.
      await wallet.resolveUnlockApproval().catch(() => false)
    },
    [dispatch, wallet]
  )
}

/**
 * After a create or restore that leaves the wallet unlocked, mark it unlocked
 * only if the background still says so: a lock that came in meanwhile has
 * already set the store through its LOCKED broadcast, and wins.
 *
 * Either way the wallet has a vault now, so mark that too (isBooted): Layout
 * sends a locked page to the unlock screen only then, and a lock that came in
 * before the vault was saved found none. Both go in one update, so a page
 * that loaded before the wallet existed, and never learned it was unlocked,
 * is not sent to the unlock screen in between.
 */
async function markUnlockedUnlessLocked(
  wallet: { isUnlocked(): Promise<boolean> },
  dispatch: ReturnType<typeof useAppDispatch>
): Promise<void> {
  if (await wallet.isUnlocked()) {
    dispatch(globalActions.update({ isUnlocked: true, isBooted: true }))
  } else {
    dispatch(globalActions.update({ isBooted: true }))
  }
}

/**
 * A create or restore that fails may have saved the wallet first: a lock that
 * lands while a restore saves the wallet fails the step after the save, which
 * records the saved wallet's history. If the background is locked and has a
 * vault, mark the vault, so the page goes to the unlock screen as after one
 * that returned. Only while locked: a page that never learned it was unlocked
 * would otherwise be sent there while the wallet is unlocked. A read that
 * fails changes nothing.
 *
 * The caller rethrows its error without waiting for this: a background that
 * is restarting or stuck must not keep the error from the screen. So it never
 * rejects, and it may publish after the screen that called it has gone: the
 * store outlives the screen, and the vault it marks is still there.
 */
async function markVaultIfSavedWhileLocked(
  wallet: { isUnlocked(): Promise<boolean>; hasVault(): Promise<boolean> },
  dispatch: ReturnType<typeof useAppDispatch>
): Promise<void> {
  try {
    if (!(await wallet.isUnlocked()) && (await wallet.hasVault())) {
      dispatch(globalActions.update({ isBooted: true }))
    }
  } catch {
    // The next lock reads the vault again (AccountUpdater).
  }
}

export function useCreateAccountCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(
    async (
      mnemonics: string,
      hdPath: string,
      passphrase: string,
      addressType: AddressType,
      accountCount: number,
      accountIndexDerivation = false
    ) => {
      try {
        await wallet.createKeyringWithMnemonics(
          mnemonics,
          hdPath,
          passphrase,
          addressType,
          accountCount,
          accountIndexDerivation
        )
      } catch (error) {
        void markVaultIfSavedWhileLocked(wallet, dispatch)
        throw error
      }
      await markUnlockedUnlessLocked(wallet, dispatch)
    },
    [dispatch, wallet]
  )
}

export function useRestoreQbitWalletCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(
    async (
      mnemonics: string,
      hdPath: string,
      passphrase: string,
      addressType: AddressType,
      options?: { gapLimit?: number; maxIndexes?: number }
    ): Promise<QbitRestoreReport> => {
      let report: QbitRestoreReport
      try {
        report = await wallet.restoreQbitKeyringWithFloors(
          mnemonics,
          hdPath,
          passphrase,
          addressType,
          options ?? {}
        )
      } catch (error) {
        void markVaultIfSavedWhileLocked(wallet, dispatch)
        throw error
      }
      await markUnlockedUnlessLocked(wallet, dispatch)
      return report
    },
    [dispatch, wallet]
  )
}

export function useCreateColdWalletCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(
    async (
      xpub: string,
      addressType: AddressType,
      alianName?: string,
      hdPath?: string,
      accountCount?: number
    ) => {
      await wallet.createKeyringWithColdWallet(xpub, addressType, alianName, hdPath, accountCount)
      dispatch(globalActions.update({ isUnlocked: true }))
    },
    [dispatch, wallet]
  )
}

/**
 * Asks the background for the guarded reset. The password and the recovery
 * acknowledgement are checked there; see WalletController.resetWallet for
 * what each rejection means.
 */
export function useResetWallet() {
  const wallet = useWallet()
  return useCallback(
    (password: string, options?: QbitResetWalletOptions) => wallet.resetWallet(password, options),
    [wallet]
  )
}
