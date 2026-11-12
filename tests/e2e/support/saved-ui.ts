import type { Page } from '@playwright/test'

import { readLocalStorage } from './release-storage'

/** Where the wallet pages keep their saved UI state, the key redux-localstorage-simple gave it. */
export const SAVED_UI_KEY = 'redux_localstorage_simple_ui'

/** The saved UI state: the display preferences, and whatever else a build saved with them. */
export interface SavedUi {
  isBalanceHidden?: unknown
  balanceDetailExpanded?: unknown
  [field: string]: unknown
}

/** The saved UI state, read from an open extension page; undefined while none is saved. */
export async function savedUi(page: Page): Promise<SavedUi | undefined> {
  const value = (await readLocalStorage(page))[SAVED_UI_KEY]
  return value === undefined ? undefined : (JSON.parse(value) as SavedUi)
}

/**
 * Those of `needles` that occur anywhere in the extension origin's
 * localStorage, in a key or a value, read from an open extension page.
 */
export async function stringsInLocalStorage(
  page: Page,
  needles: readonly string[]
): Promise<string[]> {
  const entries = Object.entries(await readLocalStorage(page))
  return needles.filter(needle =>
    entries.some(([key, value]) => key.includes(needle) || value.includes(needle))
  )
}
