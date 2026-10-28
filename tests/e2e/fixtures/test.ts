import { mkdir } from 'node:fs/promises'

import { test as base, expect } from '@playwright/test'

import { E2eDiagnostics, NetworkAudit, PqcSignMetrics } from '../support/diagnostics'
import { ExtensionSession } from '../support/extension-session'
import { assertRepositoryRoot } from '../support/paths'
import { RegtestController } from '../support/regtest'

interface QbitFixtures {
  diagnostics: E2eDiagnostics
  regtest: RegtestController
  extension: ExtensionSession
  networkAudit: NetworkAudit
  pqcMetrics: PqcSignMetrics
}

export const test = base.extend<QbitFixtures>({
  diagnostics: async ({}, use) => {
    await use(new E2eDiagnostics())
  },
  networkAudit: async ({ diagnostics }, use) => {
    await use(diagnostics.networkAudit)
  },
  pqcMetrics: async ({ diagnostics }, use) => {
    await use(diagnostics.pqcMetrics)
  },
  regtest: [
    async ({}, use) => {
      assertRepositoryRoot()
      const regtest = new RegtestController()
      await regtest.resetAndStart()
      await use(regtest)
    },
    { auto: true, timeout: 480_000 },
  ],
  extension: async ({ diagnostics, regtest }, use, testInfo) => {
    const userDataDir = testInfo.outputPath('chromium-profile')
    await mkdir(userDataDir, { recursive: true })
    const extension = new ExtensionSession(userDataDir, diagnostics)
    await extension.start()
    try {
      await use(extension)
    } finally {
      try {
        await diagnostics.finalize(testInfo, extension, regtest)
      } finally {
        await extension.close()
      }
    }
  },
})

export { expect }
