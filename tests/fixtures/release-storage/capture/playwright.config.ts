import { defineConfig } from '@playwright/test'

// Captures the stored data of one released build. Not part of the e2e suite:
// run it by hand as the README in the directory above describes.
export default defineConfig({
  testDir: '.',
  testMatch: 'capture.spec.ts',
  outputDir: '../../../../test-results/release-storage-capture',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: {
    timeout: 30_000,
  },
  reporter: [['line']],
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
