import { expect, type Page } from '@playwright/test'

import type { ExtensionSession } from './extension-session'

/**
 * Waits for the tab the extension opens by itself once it is installed
 * (apps/extension/src/background/runtime/install.ts) and closes it, with every
 * other page but `keep`. The scenario's own pages are then the only wallet
 * pages, and no tab the extension opened takes the focus or turns up later as
 * the next new page.
 */
export async function closeInstallTab(extension: ExtensionSession, keep: Page): Promise<void> {
  const walletPage = `chrome-extension://${extension.extensionId}/index.html`
  await expect
    .poll(
      () =>
        extension.context.pages().some(page => page !== keep && page.url().startsWith(walletPage)),
      { timeout: 30_000 }
    )
    .toBe(true)
  for (const page of extension.context.pages()) {
    if (page !== keep) await page.close()
  }
  await keep.bringToFront()
}
