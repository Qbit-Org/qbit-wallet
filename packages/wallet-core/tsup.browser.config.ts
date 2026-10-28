import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['iife'],
  globalName: 'QbitWalletCore',
  splitting: false,
  sourcemap: false,
  clean: true,
  outDir: 'lib/browser',
  platform: 'browser',
  target: 'es2020',
  bundle: true,
  minify: true,
  external: [],
  define: {
    global: 'globalThis',
    'process.env.NODE_ENV': '"production"',
  },
  esbuildOptions(options) {
    options.alias = {
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      buffer: 'buffer',
    }
    options.inject = ['./node-polyfills.js']
    
    // 添加 WASM 加载器
    options.loader = {
      '.wasm': 'file',
    }
    
    // 配置插件处理 WASM 导入
    options.plugins = options.plugins || []
    options.plugins.push({
      name: 'wasm-loader',
      setup(build) {
        // 处理 .wasm 文件导入
        build.onResolve({ filter: /\.wasm$/ }, args => {
          return {
            path: args.path,
            namespace: 'wasm-file'
          }
        })
        
        build.onLoad({ filter: /\.wasm$/, namespace: 'wasm-file' }, async (args) => {
          const fs = require('fs')
          
          // 读取 WASM 文件
          const wasmPath = require.resolve(args.path)
          const wasmBuffer = fs.readFileSync(wasmPath)
          const wasmBase64 = wasmBuffer.toString('base64')
          
          return {
            contents: `
              const wasmBytes = Uint8Array.from(atob('${wasmBase64}'), c => c.charCodeAt(0));
              export default wasmBytes;
            `,
            loader: 'js',
          }
        })
      }
    })
  },
})