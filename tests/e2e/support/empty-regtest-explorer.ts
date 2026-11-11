import { createHash } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  QBIT_REGTEST_GENESIS_HASH,
  QBIT_REGTEST_IDENTITY_ROUTE,
  QBIT_REGTEST_ORIGIN,
  QBIT_REGTEST_TIP_HEIGHT_ROUTE,
} from '../../../packages/wallet-shared/src/constants/qbit-regtest'

const TIP_HEIGHT = 200

interface ExplorerRequest {
  method: string
  path: string
  status: number
}

function blockHash(height: number): string {
  return height === 0
    ? QBIT_REGTEST_GENESIS_HASH
    : createHash('sha256').update(`empty-regtest-block:${height}`).digest('hex')
}

/** Esplora's answer for an address that never received or spent anything. */
function emptyAddressStats(address: string) {
  const empty = {
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: 0,
  }
  return { address, chain_stats: { ...empty }, mempool_stats: { ...empty } }
}

/** Fee rates by confirmation target that never rise with the target. */
function feeEstimates(): Record<string, number> {
  const estimates: Record<string, number> = {}
  for (let target = 1; target <= 25; target += 1) {
    estimates[String(target)] = target <= 2 ? 3 : target <= 19 ? 2 : 1
  }
  for (const target of [144, 504, 1008]) estimates[String(target)] = 1
  return estimates
}

/**
 * A Qbit regtest indexer for a chain on which no wallet address has any
 * activity. It answers the wallet's identity probe, the tip and the address
 * reads, so a wallet on Regtest can be created, restored and listed without
 * the regtest stack; anything else is a 404, as the request log shows.
 *
 * The browser reaches it in place of the fixed regtest origin through the
 * host-resolver rules in `browserArgs`, which send every other host nowhere,
 * so a scenario never depends on a public service or on a regtest stack that
 * another scenario left running on that port.
 */
export class EmptyRegtestExplorer {
  readonly requests: ExplorerRequest[] = []
  private server: Server | undefined
  private portValue: number | undefined

  get port(): number {
    if (this.portValue === undefined) throw new Error('the empty regtest explorer has not started')
    return this.portValue
  }

  /**
   * Chromium switches that route the regtest origin here and keep the browser
   * offline. Without a proxy, the resolver rules decide where every request goes.
   */
  get browserArgs(): string[] {
    const regtest = new URL(QBIT_REGTEST_ORIGIN)
    return [
      '--no-proxy-server',
      `--host-resolver-rules=MAP ${regtest.host} 127.0.0.1:${this.port}, MAP * ~NOTFOUND`,
    ]
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      const method = request.method ?? 'GET'
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const answer = method === 'GET' ? this.answer(url.pathname) : undefined
      const status = answer ? 200 : 404
      this.requests.push({ method, path: url.pathname, status })
      if (!answer) {
        send(response, 404, 'text/plain', 'Not Found')
      } else if (typeof answer.body === 'string') {
        send(response, 200, 'text/plain', answer.body)
      } else {
        send(response, 200, 'application/json', JSON.stringify(answer.body))
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.portValue = (server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }

  /** The request log, for a failed scenario's attachments. */
  log(): string {
    return this.requests.length
      ? `${this.requests.map(request => `${request.status} ${request.method} ${request.path}`).join('\n')}\n`
      : '(no requests)\n'
  }

  private answer(path: string): { body: string | object } | undefined {
    if (path === QBIT_REGTEST_IDENTITY_ROUTE) return { body: blockHash(0) }
    if (path === QBIT_REGTEST_TIP_HEIGHT_ROUTE) return { body: String(TIP_HEIGHT) }
    if (path === '/blocks/tip/hash') return { body: blockHash(TIP_HEIGHT) }
    if (path === '/fee-estimates') return { body: feeEstimates() }

    const height = path.match(/^\/block-height\/(\d+)$/)
    if (height && Number(height[1]) <= TIP_HEIGHT) return { body: blockHash(Number(height[1])) }

    const address = path.match(/^\/address\/([^/]+)(\/.*)?$/)
    if (!address) return undefined
    const [, encoded = '', rest = ''] = address
    if (rest === '') {
      let decoded: string
      try {
        decoded = decodeURIComponent(encoded)
      } catch {
        return undefined
      }
      return { body: emptyAddressStats(decoded) }
    }
    if (rest === '/utxo' || /^\/txs(?:\/chain(?:\/[0-9a-f]{64})?|\/mempool)?$/.test(rest)) {
      return { body: [] }
    }
    return undefined
  }
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
  })
  response.end(body)
}
