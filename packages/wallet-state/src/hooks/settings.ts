import compareVersions from 'compare-versions'
import { useCallback } from 'react'

import { CHAINS_MAP, PlatformEnv, ThemeMode, getExplorerUrl } from '@qbit/wallet-shared'
import { ChainType } from '@qbit/wallet-types'
import { useWallet } from '../context/WalletContext'

import { AppState } from '..'
import { settingsActions } from '../reducers/settings'
import { useAppDispatch, useAppSelector } from './base'

export function useSettingsState(): AppState['settings'] {
  return useAppSelector(state => state.settings)
}

export function useChainType() {
  const accountsState = useSettingsState()
  return accountsState.chainType
}

export function useChain() {
  const accountsState = useSettingsState()
  return CHAINS_MAP[accountsState.chainType]
}

export function useChangeChainTypeCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(
    async (type: ChainType) => {
      await wallet.setChainType(type)
      dispatch(
        (settingsActions as any).updateSettings({
          chainType: type,
        })
      )
    },
    [dispatch]
  )
}

export function useQbitUnit() {
  const chainType = useChainType()
  return CHAINS_MAP[chainType]!.unit
}

export function useTxExplorerUrl(txid: string) {
  const chain = useChain()!
  return getExplorerUrl(chain, 'tx', txid) ?? ''
}

export function useIconBaseUrl() {
  const chainType = useChainType()
  return CHAINS_MAP[chainType]!.iconBaseUrl
}

export function useWalletConfig() {
  const accountsState = useSettingsState()
  return accountsState.walletConfig
}

export function useVersionInfo() {
  const accountsState = useSettingsState()
  const walletConfig = accountsState.walletConfig
  const newVersion = walletConfig.version
  const skippedVersion = accountsState.skippedVersion
  const currentVesion = PlatformEnv.VERSION
  let skipped = false
  let latestVersion = ''
  // skip if new version is empty
  if (!newVersion) {
    skipped = true
  }

  // skip if skipped
  if (newVersion == skippedVersion) {
    skipped = true
  }

  // skip if current version is greater or equal to new version
  if (currentVesion && newVersion) {
    if (compareVersions(currentVesion, newVersion) >= 0) {
      skipped = true
    } else {
      latestVersion = newVersion
    }
  }

  // skip if current version is 0.0.0
  if (currentVesion === '0.0.0') {
    skipped = true
  }
  return {
    currentVesion,
    newVersion,
    latestVersion,
    skipped,
    downloadUrl: '',
    isNewest: false,
  }
}

export function useSkipVersionCallback() {
  const wallet = useWallet()
  const dispatch = useAppDispatch()
  return useCallback((version: string) => {
    wallet.setSkippedVersion(version).then(v => {
      dispatch((settingsActions as any).updateSettings({ skippedVersion: version }))
    })
  }, [])
}

export function useAutoLockTimeId() {
  const state = useSettingsState()
  return state.autoLockTimeId
}

export function useAddressTips() {
  return {
    homeTip: '',
    sendTip: '',
  }
}

export function useDeveloperMode() {
  const settings = useSettingsState()
  return settings.developerMode
}

export function useThemeMode() {
  const settings = useSettingsState()
  return settings.themeMode
}

export function useSetThemeModeCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(
    async (themeMode: ThemeMode) => {
      await wallet.setThemeMode(themeMode)
      dispatch(
        (settingsActions as any).updateSettings({
          themeMode,
        })
      )
    },
    [dispatch, wallet]
  )
}

export function useSetDeveloperModeCallback() {
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  return useCallback(
    async (developerMode: boolean) => {
      await wallet.setDeveloperMode(developerMode)
      dispatch(
        (settingsActions as any).updateSettings({
          developerMode,
        })
      )
    },
    [dispatch, wallet]
  )
}
