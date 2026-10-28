import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      src: resolve(__dirname, './src'),
      '@qbit/base-utils': resolve(__dirname, '../base-utils/src/index.ts'),
      '@qbit/wallet-shared': resolve(__dirname, '../wallet-shared/src/index.ts'),
      '@qbit/wallet-types': resolve(__dirname, '../wallet-types/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    exclude: ['node_modules', 'dist', 'build'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})
