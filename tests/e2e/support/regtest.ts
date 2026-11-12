import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { repositoryRoot } from './paths'

const execFileAsync = promisify(execFile)
const DEFAULT_RPC_HOST = '127.0.0.1'
const DEFAULT_RPC_PORT = '18452'
const DEFAULT_ELECTRS_URL = 'http://127.0.0.1:3002'
const ELECTRS_INDEX_TIMEOUT_MS = 300_000
// The budget of the script calls that mine hundreds of blocks, as `fund`
// gives the 1001 blocks it may mine; `mine` keeps the script default.
const BULK_MINING_TIMEOUT_MS = 300_000
/**
 * The depth at which the wallet spends a coinbase output:
 * `isQbitCoinbaseMature` (packages/wallet-background/src/utils/qbit-api.ts)
 * against `QBIT_COINBASE_MATURITY`, 1000, from @qbit-oss/protocol. The
 * regtest node agrees: it refuses a spend at depth 999
 * (`bad-txns-premature-spend-of-coinbase`). `QBIT_REGTEST_COINBASE_MATURITY`
 * (scripts/regtest/env.sh) is deliberately not read: it only sizes the
 * funding script's own maturing, and a run that set it lower would still
 * need depth 1000 here, the wallet's own rule.
 */
export const REGTEST_COINBASE_MATURITY = 1000

/** One half of electrs' `/address/:address` statistics. */
export interface ElectrsTxoStats {
  funded_txo_count: number
  spent_txo_count: number
  tx_count: number
}

/** electrs' `/address/:address` statistics: confirmed (`chain_stats`) and pending. */
export interface ElectrsAddressStats {
  chain_stats: ElectrsTxoStats
  mempool_stats: ElectrsTxoStats
}

/** electrs' answer to `/address/:address/utxo`, whatever its status. */
export interface ElectrsUtxoListing {
  status: number
  contentType: string | null
  body: string
}

export interface RegtestSnapshot {
  chain: string
  blocks: number
  bestBlockHash: string
  mempoolTxids: string[]
  loadedWallets: string[]
  electrsHeight: number
  trackedTransactionIds: string[]
  trackedAccountIds: string[]
}

export interface RegtestMempoolEntry {
  fees: {
    base: number
  }
}

interface RpcEnvelope<T> {
  result: T
  error: { code: number; message: string } | null
}

interface ElectrsUtxo {
  txid: string
  status: {
    confirmed: boolean
    block_height?: number
  }
}

export class RegtestController {
  readonly trackedTransactionIds = new Set<string>()
  readonly trackedAccountIds = new Set<string>()

  async resetAndStart(): Promise<void> {
    this.trackedTransactionIds.clear()
    this.trackedAccountIds.clear()
    await this.runScript('reset', [], 120_000)
    await this.runScript('up', [], 300_000)

    const info = await this.rpc<{ chain: string; blocks: number }>('getblockchaininfo')
    if (info.chain !== 'regtest' || info.blocks !== 0) {
      throw new Error(`regtest reset was not clean: chain=${info.chain} blocks=${info.blocks}`)
    }
  }

  trackAccount(accountId: string): void {
    if (accountId) this.trackedAccountIds.add(accountId)
  }

  async fund(address: string, amount: string | number): Promise<string> {
    this.trackAccount(address)
    const txid = (await this.runScript('fund', [address, String(amount)], 300_000)).trim()
    if (!/^[0-9a-f]{64}$/i.test(txid)) {
      throw new Error(`regtest fund returned an invalid transaction id: ${txid}`)
    }
    this.trackedTransactionIds.add(txid)
    await this.waitForElectrsTip()
    await this.waitForElectrsUtxo(address, txid)
    return txid
  }

  async mine(blocks: number, address?: string): Promise<string[]> {
    return this.mineWithin(blocks, address)
  }

  private async mineWithin(
    blocks: number,
    address: string | undefined,
    timeout?: number
  ): Promise<string[]> {
    if (!Number.isSafeInteger(blocks) || blocks <= 0) {
      throw new Error(`blocks must be a positive integer, got ${blocks}`)
    }
    const output = await this.runScript(
      'mine',
      address ? [String(blocks), address] : [String(blocks)],
      timeout
    )
    const hashes = JSON.parse(output) as unknown
    if (!Array.isArray(hashes) || hashes.some(hash => typeof hash !== 'string')) {
      throw new Error(`regtest mine returned invalid JSON: ${output}`)
    }
    await this.waitForElectrsTip()
    return hashes
  }

  /**
   * Gives `address` `count` coinbase outputs, one per block, as a miner's
   * payout address receives them, and matures every one: `count` blocks
   * mined to it, then blocks to the funding wallet until the newest of them
   * is at `REGTEST_COINBASE_MATURITY`.
   */
  async mineMatureCoinbaseOutputs(address: string, count: number): Promise<void> {
    this.trackAccount(address)
    await this.mineWithin(count, address, BULK_MINING_TIMEOUT_MS)
    await this.mineWithin(REGTEST_COINBASE_MATURITY - 1, undefined, BULK_MINING_TIMEOUT_MS)
  }

  /** electrs' statistics for `address`, read past any cache. */
  async electrsAddressStats(address: string): Promise<ElectrsAddressStats> {
    const response = await fetch(this.electrsUrl(`/address/${encodeURIComponent(address)}`), {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`electrs statistics for ${address} failed with HTTP ${response.status}`)
    }
    const body = (await response.json()) as Partial<ElectrsAddressStats>
    for (const half of [body.chain_stats, body.mempool_stats]) {
      if (
        !half ||
        ![half.funded_txo_count, half.spent_txo_count, half.tx_count].every(
          count => Number.isSafeInteger(count) && count >= 0
        )
      ) {
        throw new Error(`electrs returned invalid statistics for ${address}`)
      }
    }
    return body as ElectrsAddressStats
  }

  /** electrs' answer to the listing of `address`'s unspent outputs, refusals included. */
  async electrsUtxoListing(address: string): Promise<ElectrsUtxoListing> {
    const response = await fetch(this.electrsUrl(`/address/${encodeURIComponent(address)}/utxo`), {
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.text(),
    }
  }

  trackTransaction(transactionId: string): void {
    if (!/^[0-9a-f]{64}$/i.test(transactionId)) {
      throw new Error(`cannot track invalid transaction id: ${transactionId}`)
    }
    this.trackedTransactionIds.add(transactionId)
  }

  async waitForMempoolTransaction(transactionId: string): Promise<void> {
    this.trackTransaction(transactionId)
    await this.waitFor(`transaction ${transactionId} to enter the mempool`, async () =>
      (await this.rpc<string[]>('getrawmempool')).includes(transactionId)
    )
  }

  async mempoolFeeBaseUnits(transactionId: string): Promise<number> {
    const entry = await this.rpc<RegtestMempoolEntry>('getmempoolentry', [transactionId])
    const fee = Math.round(entry.fees.base * 100_000_000)
    if (!Number.isSafeInteger(fee) || fee <= 0) {
      throw new Error(`mempool exposed an invalid fee for ${transactionId}: ${entry.fees.base}`)
    }
    return fee
  }

  async waitForElectrsTip(): Promise<number> {
    const expectedHeight = await this.rpc<number>('getblockcount')
    await this.waitFor(
      `electrs to index block ${expectedHeight}`,
      async () => (await this.getElectrsHeight()) >= expectedHeight,
      ELECTRS_INDEX_TIMEOUT_MS
    )
    return expectedHeight
  }

  async rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const rpcUrl = new URL(
      process.env['QBIT_REGTEST_RPC_URL'] ||
        `http://${process.env['QBIT_REGTEST_RPC_HOST'] || DEFAULT_RPC_HOST}:${process.env['QBIT_REGTEST_RPC_PORT'] || DEFAULT_RPC_PORT}/`
    )
    if (wallet) rpcUrl.pathname = `/wallet/${encodeURIComponent(wallet)}`
    const username = process.env['QBIT_RPC_USER'] || 'qbit'
    const password = process.env['QBIT_RPC_PASSWORD'] || 'qbit'
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: `playwright-${method}`, method, params }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`qbit RPC ${method} failed with HTTP ${response.status}`)
    }
    const body = (await response.json()) as RpcEnvelope<T>
    if (body.error) throw new Error(`qbit RPC ${method} failed: ${body.error.message}`)
    return body.result
  }

  async snapshot(): Promise<RegtestSnapshot> {
    const [blockchain, mempoolTxids, loadedWallets, electrsHeight] = await Promise.all([
      this.rpc<{ chain: string; blocks: number; bestblockhash: string }>('getblockchaininfo'),
      this.rpc<string[]>('getrawmempool'),
      this.rpc<string[]>('listwallets'),
      this.getElectrsHeight(),
    ])
    return {
      chain: blockchain.chain,
      blocks: blockchain.blocks,
      bestBlockHash: blockchain.bestblockhash,
      mempoolTxids,
      loadedWallets,
      electrsHeight,
      trackedTransactionIds: [...this.trackedTransactionIds],
      trackedAccountIds: [...this.trackedAccountIds],
    }
  }

  private electrsUrl(path: string): string {
    return `${process.env['QBIT_REGTEST_ELECTRS_HTTP_URL'] || DEFAULT_ELECTRS_URL}${path}`
  }

  private async getElectrsHeight(): Promise<number> {
    const response = await fetch(this.electrsUrl('/blocks/tip/height'), {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`electrs height failed with HTTP ${response.status}`)
    const height = Number(await response.text())
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new Error(`electrs returned an invalid height: ${height}`)
    }
    return height
  }

  private async waitForElectrsUtxo(address: string, transactionId: string): Promise<void> {
    const url = this.electrsUrl(`/address/${encodeURIComponent(address)}/utxo`)
    await this.waitFor(
      `electrs to expose confirmed transaction ${transactionId} exactly once`,
      async () => {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) {
          throw new Error(`electrs UTXO request failed with HTTP ${response.status}`)
        }
        const body: unknown = await response.json()
        if (!Array.isArray(body)) {
          throw new Error('electrs returned an invalid UTXO response')
        }
        const matches = body.filter(
          (candidate): candidate is ElectrsUtxo =>
            Boolean(candidate) &&
            typeof candidate === 'object' &&
            'txid' in candidate &&
            candidate.txid === transactionId &&
            'status' in candidate &&
            Boolean(candidate.status) &&
            typeof candidate.status === 'object' &&
            'confirmed' in candidate.status &&
            typeof candidate.status.confirmed === 'boolean'
        )
        if (
          matches.length !== 1 ||
          !matches[0]?.status.confirmed ||
          !Number.isSafeInteger(matches[0].status.block_height)
        ) {
          const states = matches.map(utxo =>
            utxo.status.confirmed ? `confirmed@${utxo.status.block_height ?? 'unknown'}` : 'mempool'
          )
          throw new Error(
            `electrs returned ${matches.length} copies of ${transactionId}: ${states.join(', ') || 'missing'}`
          )
        }
        return true
      },
      ELECTRS_INDEX_TIMEOUT_MS
    )
  }

  private async waitFor(
    description: string,
    condition: () => Promise<boolean>,
    timeout = 30_000
  ): Promise<void> {
    const deadline = Date.now() + timeout
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        if (await condition()) return
      } catch (error) {
        lastError = error
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
    const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
    throw new Error(`timed out waiting for ${description}${suffix}`)
  }

  private async runScript(name: string, args: string[], timeout = 120_000): Promise<string> {
    const scriptPath = resolve(repositoryRoot, 'scripts/regtest', name)
    await readFile(scriptPath)
    const result = await execFileAsync('bash', [scriptPath, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, QBIT_REGTEST_REQUIRED: '1' },
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    })
    return result.stdout
  }
}
