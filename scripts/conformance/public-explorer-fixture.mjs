#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function importBuiltPackage(packageName, relativeLibPath) {
  try {
    return await import(pathToFileURL(resolve(root, relativeLibPath)).href)
  } catch (error) {
    throw new Error(
      `failed to load built ${packageName} from ${relativeLibPath} ` +
        `(build it with \`corepack pnpm --filter ${packageName} build\`): ` +
        (error instanceof Error ? error.message : String(error))
    )
  }
}

const [{ ChainType }, { CHAINS_MAP, getExplorerUrl }] = await Promise.all([
  importBuiltPackage('@qbit/wallet-types', 'packages/wallet-types/lib/index.mjs'),
  importBuiltPackage('@qbit/wallet-shared', 'packages/wallet-shared/lib/index.mjs'),
])

const fixtureTxid = '1c55c394c54e9a8925eaa46da2c474f7ea0f3fde2c4293b9058dcece8ef0eb58'

const testnet4Chain = CHAINS_MAP?.[ChainType?.QBIT_TESTNET4]
if (!testnet4Chain || typeof testnet4Chain !== 'object') {
  throw new Error('production CHAINS_MAP does not define a Qbit Testnet4 chain')
}

const explorerUrl =
  typeof getExplorerUrl === 'function'
    ? getExplorerUrl(testnet4Chain, 'tx', fixtureTxid)
    : undefined
if (typeof explorerUrl !== 'string' || !explorerUrl) {
  throw new Error(
    'production configuration did not produce a Qbit Testnet4 explorer transaction URL'
  )
}

const apiBaseUrl = Array.isArray(testnet4Chain.endpoints)
  ? String(testnet4Chain.endpoints[0] ?? '').replace(/\/+$/, '')
  : ''
if (!apiBaseUrl) {
  throw new Error('production configuration did not produce a Qbit Testnet4 API base URL')
}

export const PUBLIC_EXPLORER_FIXTURE = Object.freeze({
  network: testnet4Chain.label,
  txid: fixtureTxid,
  apiBaseUrl,
  explorerUrl,
})

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

export async function validatePublicExplorerFixture(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')

  const { apiBaseUrl, explorerUrl, network, txid } = PUBLIC_EXPLORER_FIXTURE
  const apiUrl = `${apiBaseUrl}/tx/${txid}`

  const apiResponse = await fetchImpl(apiUrl, {
    headers: { accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  if (!apiResponse.ok) {
    throw new Error(`transaction API returned HTTP ${apiResponse.status}`)
  }

  const transaction = assertObject(await apiResponse.json(), 'transaction response')
  if (typeof transaction.txid !== 'string' || transaction.txid.toLowerCase() !== txid) {
    throw new Error(`transaction API returned an unexpected txid: ${String(transaction.txid)}`)
  }
  const status = assertObject(transaction.status, 'transaction status')
  if (status.confirmed !== true || !Number.isInteger(status.block_height)) {
    throw new Error('fixture transaction is not confirmed at an integer block height')
  }
  if (
    !Array.isArray(transaction.vin) ||
    !transaction.vin.some(
      input =>
        input &&
        typeof input === 'object' &&
        Array.isArray(input.witness) &&
        input.witness.length > 0
    )
  ) {
    throw new Error('fixture transaction does not expose witness data')
  }

  const explorerResponse = await fetchImpl(explorerUrl, {
    headers: { accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  if (!explorerResponse.ok) {
    throw new Error(`explorer transaction page returned HTTP ${explorerResponse.status}`)
  }
  const explorerBody = await explorerResponse.text()
  if (!explorerBody.trim()) throw new Error('explorer transaction page returned an empty body')

  return {
    network,
    txid,
    apiUrl,
    explorerUrl,
    blockHeight: status.block_height,
    apiStatus: apiResponse.status,
    explorerStatus: explorerResponse.status,
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const result = await validatePublicExplorerFixture()
    console.log(
      [
        '[public-explorer-fixture] OK:',
        `network=${result.network}`,
        `txid=${result.txid}`,
        `block=${result.blockHeight}`,
        `api_http=${result.apiStatus}`,
        `explorer_http=${result.explorerStatus}`,
        `url=${result.explorerUrl}`,
      ].join(' ')
    )
  } catch (error) {
    console.error(
      `[public-explorer-fixture] FAIL: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}
