import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true, // Temporarily disable type generation to focus on functionality completion
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'lib',
  minify: false,
  treeshake: true,
  external: [
    'bitcoinjs-lib',
    '@qbit/keyring-service',
    '@qbit/permission-service',
    '@qbit/wallet-types',
    '@qbit/tx-helpers',
    '@qbit/wallet-api',
    '@qbit/wallet-core',
    '@qbit/contact-book',
    '@qbit/phishing-detect',
    '@qbit/preference-service',
    '@qbit-oss/api',
  ],
})
