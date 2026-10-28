import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const extensionRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(extensionRoot, '../..');

export default defineConfig({
  root: repositoryRoot,
  resolve: {
    alias: {
      '@': resolve(extensionRoot, 'src'),
      '@qbit/base-utils': resolve(repositoryRoot, 'packages/base-utils/src/index.ts'),
      '@qbit/wallet-background': resolve(repositoryRoot, 'packages/wallet-background/src/index.ts'),
      '@qbit/wallet-shared': resolve(repositoryRoot, 'packages/wallet-shared/src/index.ts'),
      '@qbit/wallet-state': resolve(repositoryRoot, 'packages/wallet-state/src/index.ts'),
      '@qbit/wallet-types': resolve(repositoryRoot, 'packages/wallet-types/src/index.ts')
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    clearMocks: true,
    include: [
      'apps/extension/src/**/*.test.{ts,tsx}',
      'apps/extension/test/**/*.{test,spec}.{ts,tsx}'
    ]
  }
});
