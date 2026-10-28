import { beforeAll, afterAll } from 'vitest'
import * as transactionCore from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1'

beforeAll(() => {
  // Setup global test environment
  process.env.NODE_ENV = 'test'
  
  // Initialize the transaction library's ECC backend.
  transactionCore.initEccLib(ecc)
})

afterAll(() => {
  // Cleanup after all tests
})
