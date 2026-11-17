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

/**
 * Esplora's answer for an address that never received or spent anything, or,
 * with `fundedSats`, one that received that much in one confirmed output and
 * spent nothing.
 */
function addressStats(address: string, fundedSats = 0) {
  const empty = {
    funded_txo_count: 0,
    funded_txo_sum: 0,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: 0,
  }
  const chain =
    fundedSats > 0
      ? { ...empty, funded_txo_count: 1, funded_txo_sum: fundedSats, tx_count: 1 }
      : { ...empty }
  return { address, chain_stats: chain, mempool_stats: { ...empty } }
}

/** The address a statistics read (`GET /address/:address`, nothing after it) asks for. */
function statisticsAddress(path: string): string | undefined {
  const match = path.match(/^\/address\/([^/]+)$/)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return undefined
  }
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
  private readonly funded = new Map<string, number>()
  private readonly failing = new Set<string>()
  private readonly held = new Map<string, Promise<void>>()
  private readonly releases = new Set<() => void>()

  get port(): number {
    if (this.portValue === undefined) throw new Error('the empty regtest explorer has not started')
    return this.portValue
  }

  /**
   * Chromium switches that route the regtest origin here and keep the browser
   * offline. Without a proxy, the resolver rules decide where every request goes.
   */
  get browserArgs(): string[] {
    return this.browserArgsReaching([])
  }

  /**
   * The same switches, except that the browser also reaches each of
   * `origins`, such as a loopback dapp page, where it is. Each origin is
   * mapped onto itself: the first rule that matches a host decides, and an
   * EXCLUDE rule would also cancel the regtest mapping on 127.0.0.1.
   */
  browserArgsReaching(origins: readonly string[]): string[] {
    const regtest = new URL(QBIT_REGTEST_ORIGIN)
    const reachable = origins.map(origin => {
      const { host } = new URL(origin)
      return `MAP ${host} ${host}`
    })
    return [
      '--no-proxy-server',
      `--host-resolver-rules=${[`MAP ${regtest.host} 127.0.0.1:${this.port}`, ...reachable, 'MAP * ~NOTFOUND'].join(', ')}`,
    ]
  }

  /**
   * From now on the statistics read of `address` reports `sats` received in
   * one confirmed output; its outputs and history still list nothing. Only
   * for an address of which the wallet reads no more than the statistics,
   * such as an account the account switcher lists that is not current: the
   * home screen's balance, which also lists the outputs, would find them
   * missing.
   */
  reportFunds(address: string, sats: number): void {
    if (!Number.isSafeInteger(sats) || sats < 0) {
      throw new Error(`sats must be a non-negative safe integer, got ${sats}`)
    }
    this.funded.set(address, sats)
  }

  /** From now on the statistics read of `address` fails with HTTP 503. */
  failStatistics(address: string): void {
    this.failing.add(address)
  }

  /**
   * The statistics reads of `address` from now on get no answer until the
   * returned function is called; then each is answered as usual.
   */
  holdStatistics(address: string): () => void {
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    this.held.set(address, held)
    const releaseHeld = (): void => {
      if (this.held.get(address) === held) this.held.delete(address)
      this.releases.delete(releaseHeld)
      release()
    }
    this.releases.add(releaseHeld)
    return releaseHeld
  }

  /** How many statistics reads of `address` (`GET /address/:address`) arrived so far. */
  statisticsRequests(address: string): number {
    return this.requests.filter(
      request => request.method === 'GET' && statisticsAddress(request.path) === address
    ).length
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.respond(request.method ?? 'GET', request.url ?? '/', response)
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

  private async respond(method: string, target: string, response: ServerResponse): Promise<void> {
    const url = new URL(target, 'http://127.0.0.1')
    // Logged as it arrives, so a scenario can count a read that is held.
    const entry: ExplorerRequest = { method, path: url.pathname, status: 0 }
    this.requests.push(entry)
    const statistics = method === 'GET' ? statisticsAddress(url.pathname) : undefined
    const held = statistics === undefined ? undefined : this.held.get(statistics)
    if (held) {
      await held
      if (response.destroyed) return
    }
    if (statistics !== undefined && this.failing.has(statistics)) {
      entry.status = 503
      send(response, 503, 'text/plain', 'Service Unavailable')
      return
    }
    const answer = method === 'GET' ? this.answer(url.pathname) : undefined
    entry.status = answer ? 200 : 404
    if (!answer) {
      send(response, 404, 'text/plain', 'Not Found')
    } else if (typeof answer.body === 'string') {
      send(response, 200, 'text/plain', answer.body)
    } else {
      send(response, 200, 'application/json', JSON.stringify(answer.body))
    }
  }

  private statistics(address: string) {
    return addressStats(address, this.funded.get(address))
  }

  async close(): Promise<void> {
    for (const release of this.releases) release()
    this.releases.clear()
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
      return { body: this.statistics(decoded) }
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
