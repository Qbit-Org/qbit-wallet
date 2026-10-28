import { defineConfig } from 'vitest/config'

// Regtest e2e suite: excluded from the default unit-test include (test/**) and
// run explicitly via `pnpm test:integration:send-flow` with the harness up.
// @qbit-oss/pqc needs no alias: the lockfile installs one copy, which
// keyring-service resolves too, so both share one initialised WASM module.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test-integration/**/*.regtest.test.ts'],
    exclude: ['node_modules', 'dist', 'build'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
