// Node.js polyfills for browser environment
import { Buffer } from 'buffer'

// Polyfill for Buffer
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}

// Polyfill for process
if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: { NODE_ENV: 'production' },
    nextTick: (cb) => setTimeout(cb, 0),
    version: 'v16.0.0',
    versions: { node: '16.0.0' }
  }
}