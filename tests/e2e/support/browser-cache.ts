import type { Page } from '@playwright/test'

/**
 * Drops the browser's HTTP cache for the profile behind `page`, which holds
 * the extension service worker's fetches, where the wallet reads the
 * explorer. The regtest explorer lets each reply be reused for 10 s
 * (`cache-control: public, max-age=10`), and a scenario changes the chain
 * faster than a person could: this stands in for those ten seconds, so the
 * wallet's next read after a change is not a reply from before it.
 */
export async function dropBrowserHttpCache(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Network.clearBrowserCache')
  } finally {
    await session.detach()
  }
}
