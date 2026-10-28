import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/types/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outDir: 'lib',
  sourcemap: true,
  splitting: false,
  minify: false,
  treeshake: true,
  external: [
    'react',
    'react-redux',
    '@reduxjs/toolkit',
    '@qbit/wallet-types',
    '@qbit/wallet-shared',
    '@qbit/keyring-service',
    '@qbit/base-utils',
  ],
})
