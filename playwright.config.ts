import { defineConfig } from '@playwright/test'

const isCI = process.env['CI'] === 'true'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  failOnFlakyTests: isCI,
  retries: isCI ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/playwright/results.json' }],
  ],
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  globalTeardown: './tests/e2e/global-teardown.ts',
})
