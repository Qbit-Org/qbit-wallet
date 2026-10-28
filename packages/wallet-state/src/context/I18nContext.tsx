import { FALLBACK_LOCALE } from '@qbit/wallet-shared'
import log from 'loglevel'
import React, { createContext, useContext, useEffect, useState } from 'react'

export interface I18nContextType {
  t: (key: string, substitutions?: string | string[] | Record<string, string | number>) => string
  locale: string
  supportedLocales: string[]
  localeNames: Record<string, string>
  changeLocale: (locale: string) => Promise<void>
  addResourceBundle?: (locale: string) => Promise<void>
  isSpecialLocale: boolean
}

// Create context
export const I18nContext = createContext<I18nContextType>({
  t: key => key,
  locale: FALLBACK_LOCALE,
  supportedLocales: [],
  localeNames: {},
  changeLocale: async () => {},
  addResourceBundle: async () => {},
  isSpecialLocale: false,
})

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) {
    throw Error('Feature flag hooks can only be used by children of BridgeProvider.')
  } else {
    return context
  }
}
