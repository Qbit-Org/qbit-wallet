import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type Plugin } from 'vitest/config';

const extensionRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(extensionRoot, '../..');

// Some of this repository's packages import their own files as `src` or
// `src/...`, which resolves only in a package's own tests, run from its root.
// The tests here take those packages from their sources, so such an import is
// resolved from the package of the file that makes it. Without this, a test
// could only load them from their builds.
// With forward slashes on every platform, as the importers' ids have them.
const packagesRoot = `${resolve(repositoryRoot, 'packages').replace(/\\/g, '/')}/`;
const packageSourceImports = (): Plugin => ({
  name: 'package-source-imports',
  enforce: 'pre',
  resolveId(source, importer) {
    if ((source !== 'src' && !source.startsWith('src/')) || !importer?.startsWith(packagesRoot)) return null;
    const packageName = /^([^/]+)\/src\//.exec(importer.slice(packagesRoot.length))?.[1];
    if (!packageName) return null;
    return this.resolve(resolve(packagesRoot, packageName, source), importer, { skipSelf: true });
  }
});

export default defineConfig({
  root: repositoryRoot,
  plugins: [packageSourceImports()],
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
