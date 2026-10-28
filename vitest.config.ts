import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['packages/**/test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist', 'build'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['packages/**/src/**/*.{js,ts}'],
      exclude: [
        'packages/**/test/**/*.{test,spec}.{js,ts}',
        'packages/**/src/**/index.ts',
        'packages/**/dist/**',
      ],
    },
    testTimeout: 10000,
  },
})
