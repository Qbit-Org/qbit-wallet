import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PUBLIC_EXPLORER_FIXTURE,
  validatePublicExplorerFixture,
} from './public-explorer-fixture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function response({ body, json, ok = true, status = 200 }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => body ?? '',
  }
}

test('fixture explorer URL equals the production wallet-generated URL', async () => {
  const [{ ChainType }, { CHAINS_MAP, getExplorerUrl }] = await Promise.all([
    import(pathToFileURL(resolve(root, 'packages/wallet-types/lib/index.mjs')).href),
    import(pathToFileURL(resolve(root, 'packages/wallet-shared/lib/index.mjs')).href),
  ])

  const productionUrl = getExplorerUrl(
    CHAINS_MAP[ChainType.QBIT_TESTNET4],
    'tx',
    PUBLIC_EXPLORER_FIXTURE.txid
  )
  assert.equal(PUBLIC_EXPLORER_FIXTURE.explorerUrl, productionUrl)
  assert.equal(
    PUBLIC_EXPLORER_FIXTURE.explorerUrl,
    `https://mempool-testnet.qbit.org/tx/${PUBLIC_EXPLORER_FIXTURE.txid}`
  )
  assert.equal(
    PUBLIC_EXPLORER_FIXTURE.apiBaseUrl,
    CHAINS_MAP[ChainType.QBIT_TESTNET4].endpoints[0]
  )
})

test('validates the pinned transaction API payload and production explorer URL', async () => {
  const calls = []
  const result = await validatePublicExplorerFixture(async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) {
      return response({
        json: {
          txid: PUBLIC_EXPLORER_FIXTURE.txid,
          status: { confirmed: true, block_height: 57_000 },
          vin: [{ witness: ['00', '11'] }],
        },
      })
    }
    return response({ body: '<!doctype html><title>Qbit explorer</title>' })
  })

  assert.equal(result.blockHeight, 57_000)
  assert.deepEqual(
    calls.map(call => call.url),
    [
      `${PUBLIC_EXPLORER_FIXTURE.apiBaseUrl}/tx/${PUBLIC_EXPLORER_FIXTURE.txid}`,
      PUBLIC_EXPLORER_FIXTURE.explorerUrl,
    ]
  )
  assert.equal(calls[0].init.headers.accept, 'application/json')
  assert.equal(calls[1].init.headers.accept, 'text/html')
})

test('fails closed when the API payload has no witness data', async () => {
  await assert.rejects(
    validatePublicExplorerFixture(async () =>
      response({
        json: {
          txid: PUBLIC_EXPLORER_FIXTURE.txid,
          status: { confirmed: true, block_height: 57_000 },
          vin: [{ witness: [] }],
        },
      })
    ),
    /does not expose witness data/
  )
})

test('fails closed when the explorer page is unavailable', async () => {
  let call = 0
  await assert.rejects(
    validatePublicExplorerFixture(async () => {
      call += 1
      if (call === 1) {
        return response({
          json: {
            txid: PUBLIC_EXPLORER_FIXTURE.txid,
            status: { confirmed: true, block_height: 57_000 },
            vin: [{ witness: ['00'] }],
          },
        })
      }
      return response({ ok: false, status: 503 })
    }),
    /explorer transaction page returned HTTP 503/
  )
})
