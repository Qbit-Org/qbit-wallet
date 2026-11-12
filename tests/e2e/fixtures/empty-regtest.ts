import { mkdir } from 'node:fs/promises'

import { test as base, expect } from '@playwright/test'

import { EmptyRegtestExplorer } from '../support/empty-regtest-explorer'
import { ExtensionSession } from '../support/extension-session'
import { assertRepositoryRoot } from '../support/paths'

/**
 * Scenarios that need no regtest node: the wallets live on Regtest, whose
 * indexer is a loopback stand-in for a chain on which no address has any
 * activity, and every other host resolves nowhere.
 */
export const test = base.extend<{ explorer: EmptyRegtestExplorer; extension: ExtensionSession }>({
  // Playwright reads a fixture's dependencies from this pattern; this one has none.
  // eslint-disable-next-line no-empty-pattern
  explorer: async ({}, use, testInfo) => {
    const explorer = new EmptyRegtestExplorer()
    await explorer.start()
    try {
      await use(explorer)
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach('empty-regtest-explorer.log', {
            body: explorer.log(),
            contentType: 'text/plain',
          })
        }
      } finally {
        await explorer.close()
      }
    }
  },
  extension: async ({ explorer }, use, testInfo) => {
    assertRepositoryRoot()
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const extension = new ExtensionSession(userDataDir, undefined, {
      browserArgs: explorer.browserArgs,
    })
    await extension.start()
    try {
      await use(extension)
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          await extension.attachServiceWorkerLog(testInfo)
        }
      } finally {
        await extension.close()
      }
    }
  },
})

export { expect }
