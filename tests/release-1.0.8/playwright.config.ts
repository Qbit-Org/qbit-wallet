import { defineConfig } from '@playwright/test'

// Release checks for 1.0.8 that the G3 gate does not run: they need the
// published release ZIPs, or drive flows the gate does not. Run them by hand
// as README.md in this directory describes.
//
// Offline specs each use their own browser profile and loopback servers, so
// they run in parallel. The regtest specs share one regtest node, which each
// test resets, so they run one at a time.
const REGTEST_SPECS = /(regtest|slow-upload)\.spec\.ts$/

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../test-results/release-1.0.8',
  fullyParallel: true,
  workers: Number(process.env['QBIT_RELEASE_WORKERS'] || 6),
  retries: 0,
  timeout: 10 * 60_000,
  expect: {
    timeout: 30_000,
  },
  reporter: [['line'], ['json', { outputFile: '../../test-results/release-1.0.8/results.json' }]],
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'offline', testIgnore: REGTEST_SPECS },
    { name: 'regtest', testMatch: REGTEST_SPECS, workers: 1, fullyParallel: false },
  ],
})
