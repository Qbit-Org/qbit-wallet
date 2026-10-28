/* eslint-disable indent */
import { VersionDetail } from '@qbit/wallet-shared'
import React, { useContext } from 'react'

enum StorageType {
  ENABLE_FACEID = 'FACEIDDEFAULT',
  AUTO_LOCK_TIME = 'AutomaticLockTime',
  ENABLE_EXPLORE = 'ENABLE_EXPLORE',
  UTXO_MANAGE_VISITED = 'UTXO_MANAGE_VISITED',
  BALANCE_HIDDEN = 'HIDE_BALANCE',
  ANNOUNCEMENT_DISMISSED_IDS_KEY = '@announcement_dismissed_ids',

  I18N_SAVED_LANG = 'i18nextLng',

  WEB_SEARCH_HISTORY = 'historyList',
  WEB_RISK_WARNING = 'RiskWarning',

  UNBACKUP_KEYRINGS = 'unbackedup_keyrings',

  VERSION_DETAIL = 'version_detail',

  THEME_MODE = 'PREFERENCES',
}

type AutoLockTime = {
  id: number
  time: number
  label: string
}

type WebSearchHistoryItem = string

type WebRiskWarningItem = {
  url: string
}

const defaultVersionDetail: VersionDetail = {
  version: '',
  title: '',
  changelogs: [],
  notice: '',
}

type ThemeMode = 'light' | 'dark'
const defaultThemeMode = 'light'

export interface BaseStorageProvider {
  // storage should json.parse value after get
  get: (key: string) => Promise<any>

  // storage should json.stringify value before set
  set: (key: string, value: any) => Promise<void>
}

export interface StorageContextType {
  get: (key: string) => Promise<string>
  set: (key: string, value: string) => Promise<void>
  clear: () => Promise<void>

  getAutomaticLockTime: () => Promise<AutoLockTime>
  clearAutomaticLockTime: () => Promise<void>

  getAnnouncementDismissedIds: () => Promise<string[]>
  setAnnouncementDismissedIds: (ids: string[]) => Promise<void>
  clearAnnouncementDismissedIds: () => Promise<void>

  getI18nSavedLang: () => Promise<string>
  setI18nSavedLang: (lang: string) => Promise<void>
  clearI18nSavedLang: () => Promise<void>

  getWebSearchHistory: () => Promise<WebSearchHistoryItem[]>
  setWebSearchHistory: (history: WebSearchHistoryItem[]) => Promise<void>
  clearWebSearchHistory: () => Promise<void>

  getWebRiskWarning: () => Promise<WebRiskWarningItem[]>
  setWebRiskWarning: (warnings: WebRiskWarningItem[]) => Promise<void>
  clearWebRiskWarning: () => Promise<void>

  getEnableExplore: () => Promise<boolean>
  setEnableExplore: (enable: boolean) => Promise<void>
  clearEnableExplore: () => Promise<void>

  getUnbackupKeyringIds: () => Promise<string[]>
  setUnbackupKeyringIds: (keyrings: string[]) => Promise<void>
  clearUnbackupKeyringIds: () => Promise<void>

  getEnableFaceId: () => Promise<boolean>
  setEnableFaceId: (enable: boolean) => Promise<void>
  clearEnableFaceId: () => Promise<void>

  getBalanceHidden: () => Promise<boolean>
  setBalanceHidden: (enable: boolean) => Promise<void>
  clearBalanceHidden: () => Promise<void>

  getVersionDetail: () => Promise<VersionDetail>
  setVersionDetail: (detail: VersionDetail) => Promise<void>
  clearVersionDetail: () => Promise<void>

  getThemeMode: () => Promise<string>
  setThemeMode: (mode: string) => Promise<void>
  clearThemeMode: () => Promise<void>

  getUtxoManageVisited: () => Promise<boolean>
  setUtxoManageVisited: () => Promise<void>
  clearUtxoManageVisited: () => Promise<void>
}

const defaultContext: StorageContextType = {
  async get(key: string) {
    return ''
  },
  async set(key: string, content: string) {},

  async clear() {},

  async getAutomaticLockTime() {
    return null
  },
  async clearAutomaticLockTime() {},

  async getAnnouncementDismissedIds() {
    return []
  },
  async setAnnouncementDismissedIds(ids: string[]) {},
  async clearAnnouncementDismissedIds() {},

  async getI18nSavedLang() {
    return ''
  },
  async setI18nSavedLang(lang: string) {},
  async clearI18nSavedLang() {},

  async getWebSearchHistory() {
    return []
  },
  async setWebSearchHistory(history: WebSearchHistoryItem[]) {},
  async clearWebSearchHistory() {},

  async getWebRiskWarning() {
    return []
  },
  async setWebRiskWarning(warnings: WebRiskWarningItem[]) {},
  async clearWebRiskWarning() {},

  async getEnableExplore() {
    return false
  },
  async setEnableExplore(enable: boolean) {},
  async clearEnableExplore() {},

  async getUnbackupKeyringIds() {
    return []
  },
  async setUnbackupKeyringIds(keyringIds: string[]) {},
  async clearUnbackupKeyringIds() {},

  async getEnableFaceId() {
    return false
  },
  async setEnableFaceId(enable: boolean) {},
  async clearEnableFaceId() {},

  async getBalanceHidden() {
    return false
  },
  async setBalanceHidden(enable) {},
  async clearBalanceHidden() {},

  async getVersionDetail() {
    return defaultVersionDetail
  },
  async setVersionDetail(detail: VersionDetail) {},
  async clearVersionDetail() {},

  async getThemeMode() {
    return defaultThemeMode
  },
  async setThemeMode(mode: string) {},
  async clearThemeMode() {},

  async getUtxoManageVisited() {
    return false
  },
  async setUtxoManageVisited() {},
  async clearUtxoManageVisited() {},
}

function parseStoredObjectValue(val: any) {
  let parsedObj = null
  if (val && typeof val !== 'string') {
    return val
  }

  if (typeof val === 'string' && val.length > 0) {
    try {
      parsedObj = JSON.parse(val)
    } catch (e) {
      parsedObj = null
    }
  }

  // Handle double-stringified stored objects.
  val = parsedObj
  if (val && typeof val === 'string' && val.length > 0) {
    try {
      parsedObj = JSON.parse(val)
    } catch (e) {
      parsedObj = null
    }
  }

  return parsedObj
}

export function createStorageProvider(base: BaseStorageProvider): StorageContextType {
  const funcs = {
    ...base,

    async getAutomaticLockTime(): Promise<AutoLockTime | null> {
      const val = await base.get(StorageType.AUTO_LOCK_TIME)
      return parseStoredObjectValue(val)
    },
    async clearAutomaticLockTime() {
      await base.set(StorageType.AUTO_LOCK_TIME, null)
    },

    async getAnnouncementDismissedIds(): Promise<string[]> {
      const val = await base.get(StorageType.ANNOUNCEMENT_DISMISSED_IDS_KEY)
      return parseStoredObjectValue(val) || []
    },
    async setAnnouncementDismissedIds(ids: string[]) {
      await base.set(StorageType.ANNOUNCEMENT_DISMISSED_IDS_KEY, ids)
    },
    async clearAnnouncementDismissedIds() {
      await base.set(StorageType.ANNOUNCEMENT_DISMISSED_IDS_KEY, [])
    },

    async getI18nSavedLang() {
      const val = await base.get(StorageType.I18N_SAVED_LANG)
      return val || ''
    },
    async setI18nSavedLang(lang: string) {
      await base.set(StorageType.I18N_SAVED_LANG, lang)
    },
    async clearI18nSavedLang() {
      await base.set(StorageType.I18N_SAVED_LANG, '')
    },

    async getWebSearchHistory(): Promise<WebSearchHistoryItem[]> {
      const val = await base.get(StorageType.WEB_SEARCH_HISTORY)
      return parseStoredObjectValue(val) || []
    },
    async setWebSearchHistory(history: WebSearchHistoryItem[]) {
      await base.set(StorageType.WEB_SEARCH_HISTORY, history)
    },
    async clearWebSearchHistory() {
      await base.set(StorageType.WEB_SEARCH_HISTORY, [])
    },

    async getWebRiskWarning(): Promise<WebRiskWarningItem[]> {
      const val = await base.get(StorageType.WEB_RISK_WARNING)
      return parseStoredObjectValue(val) || []
    },
    async setWebRiskWarning(warnings: WebRiskWarningItem[]) {
      await base.set(StorageType.WEB_RISK_WARNING, warnings)
    },
    async clearWebRiskWarning() {
      await base.set(StorageType.WEB_RISK_WARNING, [])
    },

    async getEnableExplore() {
      const val = await base.get(StorageType.ENABLE_EXPLORE)
      return val === 'true'
    },
    async setEnableExplore(enable: boolean) {
      await base.set(StorageType.ENABLE_EXPLORE, String(enable))
    },
    async clearEnableExplore() {
      await base.set(StorageType.ENABLE_EXPLORE, 'false')
    },

    async getUnbackupKeyringIds(): Promise<string[]> {
      const val = await base.get(StorageType.UNBACKUP_KEYRINGS)
      return parseStoredObjectValue(val) || []
    },
    async setUnbackupKeyringIds(keyringIds: string[]) {
      await base.set(StorageType.UNBACKUP_KEYRINGS, keyringIds)
    },
    async clearUnbackupKeyringIds() {
      await base.set(StorageType.UNBACKUP_KEYRINGS, [])
    },

    //
    async getEnableFaceId() {
      const val = await base.get(StorageType.ENABLE_FACEID)
      return val === 'true' || val == true
    },
    async setEnableFaceId(enable: boolean) {
      await base.set(StorageType.ENABLE_FACEID, String(enable))
    },
    async clearEnableFaceId() {
      await base.set(StorageType.ENABLE_FACEID, 'false')
    },

    async getBalanceHidden() {
      const val = await base.get(StorageType.BALANCE_HIDDEN)
      return val === 'true'
    },
    async setBalanceHidden(enable: boolean) {
      await base.set(StorageType.BALANCE_HIDDEN, String(enable))
    },
    async clearBalanceHidden() {
      await base.set(StorageType.BALANCE_HIDDEN, 'false')
    },

    async getVersionDetail() {
      const val = await base.get(StorageType.VERSION_DETAIL)
      return parseStoredObjectValue(val) || defaultVersionDetail
    },
    async setVersionDetail(detail: VersionDetail) {
      await base.set(StorageType.VERSION_DETAIL, detail)
    },
    async clearVersionDetail() {
      await base.set(StorageType.VERSION_DETAIL, defaultVersionDetail)
    },

    async getThemeMode() {
      const val = await base.get(StorageType.THEME_MODE)
      return val || defaultThemeMode
    },
    async setThemeMode(mode: string) {
      await base.set(StorageType.THEME_MODE, mode)
    },
    async clearThemeMode() {
      await base.set(StorageType.THEME_MODE, defaultThemeMode)
    },

    async getUtxoManageVisited() {
      const val = await base.get(StorageType.UTXO_MANAGE_VISITED)
      return val === 'true'
    },
    async setUtxoManageVisited() {
      await base.set(StorageType.UTXO_MANAGE_VISITED, 'true')
    },
    async clearUtxoManageVisited() {
      await base.set(StorageType.UTXO_MANAGE_VISITED, 'false')
    },
  }

  return {
    ...funcs,
    async clear() {
      await funcs.clearAutomaticLockTime()
      await funcs.clearAnnouncementDismissedIds()
      await funcs.clearI18nSavedLang()
      await funcs.clearWebSearchHistory()
      await funcs.clearWebRiskWarning()
      await funcs.clearEnableExplore()
      await funcs.clearUnbackupKeyringIds()
      await funcs.clearEnableFaceId()
      await funcs.clearBalanceHidden()
      await funcs.clearVersionDetail()
      await funcs.clearThemeMode()
      await funcs.clearUtxoManageVisited()
    },
  }
}

export const StorageContext = React.createContext<StorageContextType>(defaultContext)

export function useStorage() {
  const ctx = useContext(StorageContext)
  return ctx
}
