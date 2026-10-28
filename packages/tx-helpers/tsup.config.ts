import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/types/index.ts'
  ],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'lib',
  target: 'es2020',
  external: [
    // Only externalize Node.js core modules that cannot be polyfilled in browser
    'fs',
    'fs/promises',
    'path'
  ],
  esbuildOptions(options, context) {
    // Allow business dependencies to be bundled
    delete options.packages;
  },
});