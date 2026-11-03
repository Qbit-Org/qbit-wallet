import { expect, type Page } from '@playwright/test'

import type { ReleaseStorage } from '../../fixtures/release-storage/release-storage'
import type { ExtensionSession } from './extension-session'

/** Resolve no host but the loopback one, so no public service is reached. */
export const OFFLINE_BROWSER_ARGS = [
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
] as const

const SETTLE_MS = 3_000
// This build's store saves the ui slice to localStorage 1000 ms after an
// action; wait well past that so no save is pending when the data is seeded.
const UI_SAVE_QUIET_MS = 3_000

/**
 * Replace the stored data of the running build with what a released build
 * wrote, then restart the browser so that this build starts from it, as it
 * does once Chrome updates the extension in place.
 *
 * Both are written from one extension page, which also keeps the service
 * worker running. The fresh install is left to settle and every other page is
 * closed first, and the page then waits out any save that closing them set
 * off. It leaves for about:blank before the restart, so this build's store
 * cannot save its own ui state over the release's in between.
 */
export async function seedReleaseStorage(
  extension: ExtensionSession,
  dump: ReleaseStorage
): Promise<void> {
  const page = await extension.openWallet('/welcome')
  await expect(page.getByTestId('create-new-wallet-button')).toBeVisible()
  // The install opens its own welcome tab, possibly only now.
  await page.waitForTimeout(SETTLE_MS)
  await Promise.all(
    extension.context
      .pages()
      .filter(open => open !== page)
      .map(open => open.close())
  )
  await page.waitForTimeout(UI_SAVE_QUIET_MS)

  const stored = await page.evaluate(
    async ({ items, storage }) => {
      localStorage.clear()
      for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value)
      await chrome.storage.local.clear()
      await chrome.storage.local.set(storage)
      return { local: { ...localStorage }, storage: await chrome.storage.local.get(null) }
    },
    { items: dump.localStorage, storage: dump.storage }
  )
  expect(stored).toEqual({ local: dump.localStorage, storage: dump.storage })

  await page.goto('about:blank')
  await extension.restart()
}

/** The extension origin's localStorage, read from an open extension page. */
export async function readLocalStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const entries: Record<string, string> = {}
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null) entries[key] = localStorage.getItem(key) ?? ''
    }
    return entries
  })
}
