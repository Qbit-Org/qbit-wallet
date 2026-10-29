import { transactionCore } from '@qbit/wallet-core'

/**
 * An in-memory explorer served over `fetch`, so tests drive the real
 * `@qbit-oss/api` clients: their paging, cursor checks, retries and error
 * classification. It models what #277 is about: electrs refuses
 * `/address/:a/utxo` with HTTP 500 for an address holding more confirmed
 * unspent outputs than `utxoLimit`, while the statistics, history pages,
 * transactions and `/tx/:txid/outspends` keep answering.
 *
 * Esplora routes page confirmed history 25 rows at a time
 * (`/txs/chain[/:last]`) and list the mempool at `/txs/mempool`. With
 * `surface: 'mempool-qbit'` the combined `/txs[?after_txid=]` route pages
 * 50 rows, mempool first, and the Esplora-only routes are missing, as on the
 * production deployment.
 */

export interface FakeOutput {
  /** Omitted for an output that pays no address (OP_RETURN). */
  address?: string
  script: string
  value: number
}

export interface FakeTx {
  txid: string
  inputs: { txid: string; vout: number }[]
  outputs: FakeOutput[]
  coinbase: boolean
  /** Undefined while in the mempool. */
  height?: number
  /** Insertion order; ties within a block sort by it, newest first. */
  order: number
}

/**
 * A failure injected into one request: a reply, or a thrown error. With
 * `afterAccepting`, the request is served first (a broadcast reaches the
 * node) and the reply then replaces its answer, as a gateway's 502 would.
 */
export type FakeFailure = (request: {
  method: string
  path: string
}) =>
  | { status: number; body?: string; afterAccepting?: boolean }
  | Error
  | 'accept-then-fail'
  | undefined

/**
 * Matching responses served as over a slow link: `chunkBytes` of the body
 * every `intervalMs`. With `stallAfterBytes` the body stops after that many
 * bytes and never ends; with `stallHeaders` the headers never arrive. Either
 * stall lasts until the request's signal aborts, as on a dead connection.
 * With `resetAfterBytes` the body fails after that many bytes, as when the
 * connection is reset.
 */
export interface FakeSlowResponse {
  match: (request: { method: string; path: string }) => boolean
  chunkBytes: number
  intervalMs: number
  stallAfterBytes?: number
  stallHeaders?: boolean
  resetAfterBytes?: number
}

const ESPLORA_PAGE = 25
const MEMPOOL_QBIT_PAGE = 50

export class FakeQbitExplorer {
  readonly txs = new Map<string, FakeTx>()
  readonly requests: { method: string; path: string }[] = []
  readonly failures: FakeFailure[] = []
  tipHeight = 2_000
  utxoLimit = 500
  feeRate = 1
  /** History rows without prevouts, as some backends serve them. */
  omitHistoryPrevouts = false
  /**
   * Answer a combined-route cursor that is the address's last mempool row
   * with HTTP 200 `[]` instead of the confirmed rows after it, as
   * qbit-electrs does: it looks that cursor up among the confirmed rows,
   * which never hold it (`src/rest.rs:992-998` in
   * Qbit-Org/qbit-electrs@53102e9).
   */
  emptyPageAfterLastMempoolRow = false
  /**
   * Witness hex carried by each input of a non-coinbase transaction. A P2MR
   * input carries about 7,400 characters, so pages reach real sizes.
   */
  inputWitnessHexLength = 0
  slowResponses: FakeSlowResponse[] = []
  /** Slow requests whose body was cancelled or aborted before it ended. */
  readonly releasedBodies: string[] = []
  /** Slow requests whose signal aborted, so the connection was released. */
  readonly abortedRequests: string[] = []
  /**
   * Accept a broadcast that spends an output an unconfirmed transaction
   * already spends, evicting that one, as qbit Core's full-RBF does for a
   * replacement paying enough. Off by default: the conflict is refused.
   */
  acceptReplacements = false
  /** Raw bytes of broadcast transactions, served at `/tx/:txid/hex`. */
  private readonly rawHex = new Map<string, string>()
  private order = 0
  private spenders: Map<string, FakeTx> | undefined
  /** Script to address, for outputs of broadcast transactions. */
  private readonly addresses = new Map<string, string>()

  constructor(readonly surface: 'esplora' | 'mempool-qbit' = 'esplora') {}

  registerAddress(address: string, script: string): void {
    this.addresses.set(script.toLowerCase(), address)
  }

  addTx(tx: Omit<FakeTx, 'order' | 'coinbase'> & { coinbase?: boolean }): FakeTx {
    const stored = { coinbase: false, ...tx, txid: tx.txid.toLowerCase(), order: this.order++ }
    this.txs.set(stored.txid, stored)
    this.spenders = undefined
    return stored
  }

  confirmMempool(height = this.tipHeight + 1): void {
    this.tipHeight = Math.max(this.tipHeight, height)
    for (const tx of this.txs.values()) {
      if (tx.height === undefined) tx.height = height
    }
  }

  removeTx(txid: string): void {
    this.txs.delete(txid.toLowerCase())
    this.spenders = undefined
  }

  spenderOf(txid: string, vout: number): FakeTx | undefined {
    if (!this.spenders) {
      this.spenders = new Map()
      for (const tx of this.txs.values()) {
        for (const input of tx.inputs) this.spenders.set(`${input.txid}:${input.vout}`, tx)
      }
    }
    return this.spenders.get(`${txid.toLowerCase()}:${vout}`)
  }

  /** Unspent outputs paying `address`, as `txid:vout`. */
  unspent(address: string, { confirmedOnly = false } = {}): Set<string> {
    const keys = new Set<string>()
    for (const tx of this.txs.values()) {
      if (confirmedOnly && tx.height === undefined) continue
      tx.outputs.forEach((output, vout) => {
        if (output.address === address && !this.spenderOf(tx.txid, vout)) {
          keys.add(`${tx.txid}:${vout}`)
        }
      })
    }
    return keys
  }

  history(address: string): FakeTx[] {
    const touches = (tx: FakeTx) =>
      tx.outputs.some(output => output.address === address) ||
      tx.inputs.some(input => this.txs.get(input.txid)?.outputs[input.vout]?.address === address)
    return [...this.txs.values()].filter(touches).sort((left, right) => {
      const leftPending = left.height === undefined
      const rightPending = right.height === undefined
      if (leftPending !== rightPending) return leftPending ? -1 : 1
      if (!leftPending && left.height !== right.height) return right.height! - left.height!
      return right.order - left.order
    })
  }

  stats(address: string) {
    const scope = (pending: boolean) => {
      const item = {
        funded_txo_count: 0,
        funded_txo_sum: 0,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: 0,
      }
      for (const tx of this.history(address)) {
        if ((tx.height === undefined) !== pending) continue
        item.tx_count += 1
        tx.outputs.forEach(output => {
          if (output.address !== address) return
          item.funded_txo_count += 1
          item.funded_txo_sum += output.value
        })
        for (const input of tx.inputs) {
          const prevout = this.txs.get(input.txid)?.outputs[input.vout]
          if (prevout?.address !== address) continue
          item.spent_txo_count += 1
          item.spent_txo_sum += prevout.value
        }
      }
      return item
    }
    return { address, chain_stats: scope(false), mempool_stats: scope(true) }
  }

  esploraTx(tx: FakeTx, { prevouts = true } = {}) {
    return {
      txid: tx.txid,
      version: 2,
      locktime: 0,
      vin: tx.coinbase
        ? [
            {
              txid: '00'.repeat(32),
              vout: 0xffffffff,
              prevout: null,
              scriptsig: '',
              scriptsig_asm: '',
              is_coinbase: true,
              sequence: 0xffffffff,
            },
          ]
        : tx.inputs.map(input => {
            const prevout = this.txs.get(input.txid)?.outputs[input.vout]
            return {
              txid: input.txid,
              vout: input.vout,
              prevout: prevouts && prevout ? this.esploraOutput(prevout) : null,
              scriptsig: '',
              scriptsig_asm: '',
              is_coinbase: false,
              sequence: 0xfffffffd,
              ...(this.inputWitnessHexLength > 0
                ? { witness: ['ab'.repeat(this.inputWitnessHexLength / 2)] }
                : {}),
            }
          }),
      vout: tx.outputs.map(output => this.esploraOutput(output)),
      size: 100 + tx.inputs.length * 3_762,
      weight: 100 + tx.inputs.length * 3_762,
      fee: 0,
      status:
        tx.height === undefined
          ? { confirmed: false }
          : {
              confirmed: true,
              block_height: tx.height,
              block_hash: tx.height.toString(16).padStart(64, '0'),
              block_time: tx.height,
            },
    }
  }

  private esploraOutput(output: FakeOutput) {
    return {
      scriptpubkey: output.script,
      scriptpubkey_asm: '',
      scriptpubkey_type: output.address ? 'v2_p2mr' : 'op_return',
      ...(output.address ? { scriptpubkey_address: output.address } : {}),
      value: output.value,
    }
  }

  /** The `fetch` the real clients are handed. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url
    )
    const method = init?.method ?? 'GET'
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`
    const request = { method, path }
    this.requests.push(request)
    let failAfterAccepting = false
    let replyAfterAccepting: { status: number; body?: string } | undefined
    for (const failure of this.failures) {
      const injected = failure(request)
      if (injected === undefined) continue
      if (injected === 'accept-then-fail') {
        failAfterAccepting = true
        continue
      }
      if (injected instanceof Error) throw injected
      if (injected.afterAccepting) {
        replyAfterAccepting = injected
        continue
      }
      return this.deliver(
        request,
        withUrl(
          new Response(injected.body ?? 'injected failure', { status: injected.status }),
          url
        ),
        url,
        init
      )
    }
    const response = withUrl(this.route(method, url, init), url)
    if (failAfterAccepting) throw new TypeError('fetch failed')
    if (replyAfterAccepting) {
      const { status, body } = replyAfterAccepting
      return this.deliver(
        request,
        withUrl(new Response(body ?? 'injected failure', { status }), url),
        url,
        init
      )
    }
    return this.deliver(request, response, url, init)
  }

  private deliver(
    request: { method: string; path: string },
    response: Response,
    url: URL,
    init?: RequestInit
  ): Response | Promise<Response> {
    const slow = this.slowResponses.find(candidate => candidate.match(request))
    if (!slow) return response
    return this.serveSlowly(slow, response, request.path, url, init?.signal ?? undefined)
  }

  private async serveSlowly(
    slow: FakeSlowResponse,
    response: Response,
    path: string,
    url: URL,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    const bytes = new Uint8Array(await response.arrayBuffer())
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let aborted: (reason: unknown) => void = () => {}
    const onAbort = () => {
      this.abortedRequests.push(path)
      for (const timer of timers) clearTimeout(timer)
      aborted(signal!.reason)
    }
    if (signal?.aborted) throw signal.reason
    signal?.addEventListener('abort', onAbort, { once: true })
    if (slow.stallHeaders) {
      return new Promise<Response>((_, reject) => {
        aborted = reject
      })
    }
    const end = Math.min(bytes.length, slow.stallAfterBytes ?? slow.resetAfterBytes ?? bytes.length)
    let sent = 0
    let ended = false
    const body = new ReadableStream<Uint8Array>({
      start: stream => {
        aborted = reason => {
          if (ended) return
          ended = true
          this.releasedBodies.push(path)
          stream.error(reason)
        }
        const next = () => {
          if (sent === end) {
            if (end < bytes.length && slow.resetAfterBytes === undefined) return // stalled
            ended = true
            signal?.removeEventListener('abort', onAbort)
            if (end < bytes.length) stream.error(new TypeError('terminated'))
            else stream.close()
            return
          }
          const timer = setTimeout(() => {
            timers.delete(timer)
            const chunk = bytes.subarray(sent, Math.min(end, sent + slow.chunkBytes))
            sent += chunk.length
            stream.enqueue(chunk)
            next()
          }, slow.intervalMs)
          timers.add(timer)
        }
        next()
      },
      cancel: () => {
        if (ended) return
        ended = true
        this.releasedBodies.push(path)
        for (const timer of timers) clearTimeout(timer)
      },
    })
    return withUrl(new Response(body, { status: response.status }), url)
  }

  private route(method: string, url: URL, init?: RequestInit): Response {
    const path = url.pathname.replace(/^\/api/, '')
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
    const text = (value: string) => new Response(value, { status: 200 })
    const notFound = () => new Response('not found', { status: 404 })
    let match: RegExpMatchArray | null

    if (method === 'POST' && path === '/tx') return this.acceptBroadcast(String(init?.body ?? ''))
    if (path === '/blocks/tip/height') return text(String(this.tipHeight))
    if (path === '/blocks/tip/hash') return text(this.tipHeight.toString(16).padStart(64, '0'))
    if (path === '/fee-estimates')
      return json({ '1': this.feeRate, '6': this.feeRate, '20': this.feeRate })
    if (path === '/fees/recommended') {
      return json({
        fastestFee: this.feeRate,
        halfHourFee: this.feeRate,
        hourFee: this.feeRate,
        economyFee: this.feeRate,
        minimumFee: this.feeRate,
      })
    }
    if ((match = path.match(/^\/tx\/([0-9a-f]{64})$/))) {
      const tx = this.txs.get(match[1]!)
      return tx ? json(this.esploraTx(tx)) : notFound()
    }
    if ((match = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) {
      const hex = this.txs.has(match[1]!) ? this.rawHex.get(match[1]!) : undefined
      return hex ? text(hex) : notFound()
    }
    if ((match = path.match(/^\/tx\/([0-9a-f]{64})\/status$/))) {
      const tx = this.txs.get(match[1]!)
      return tx ? json(this.esploraTx(tx).status) : notFound()
    }
    if ((match = path.match(/^\/tx\/([0-9a-f]{64})\/outspends$/))) {
      const tx = this.txs.get(match[1]!)
      if (!tx) return notFound()
      return json(
        tx.outputs.map((_, vout) => {
          const spender = this.spenderOf(tx.txid, vout)
          return spender ? { spent: true, txid: spender.txid, vin: 0 } : { spent: false }
        })
      )
    }
    if ((match = path.match(/^\/address\/([^/]+)$/))) {
      return json(this.stats(decodeURIComponent(match[1]!)))
    }
    if ((match = path.match(/^\/address\/([^/]+)\/utxo$/))) {
      const address = decodeURIComponent(match[1]!)
      if (this.unspent(address, { confirmedOnly: true }).size > this.utxoLimit) {
        return new Response('{"error":"Failed to get address"}', { status: 500 })
      }
      return json(
        [...this.unspent(address)].map(key => {
          const [txid, vout] = key.split(':')
          const tx = this.txs.get(txid!)!
          return {
            txid,
            vout: Number(vout),
            value: tx.outputs[Number(vout)]!.value,
            status: this.esploraTx(tx).status,
          }
        })
      )
    }
    if (this.surface === 'esplora') {
      if ((match = path.match(/^\/address\/([^/]+)\/txs\/mempool$/))) {
        const history = this.history(decodeURIComponent(match[1]!))
        return json(
          history
            .filter(tx => tx.height === undefined)
            .slice(0, 50)
            .map(tx => this.esploraTx(tx))
        )
      }
      if ((match = path.match(/^\/address\/([^/]+)\/txs\/chain(?:\/([0-9a-f]{64}))?$/))) {
        const confirmed = this.history(decodeURIComponent(match[1]!)).filter(
          tx => tx.height !== undefined
        )
        const start = match[2] ? confirmed.findIndex(tx => tx.txid === match![2]) + 1 : 0
        if (match[2] && start === 0) return new Response('invalid cursor', { status: 400 })
        return json(
          confirmed
            .slice(start, start + ESPLORA_PAGE)
            .map(tx => this.esploraTx(tx, { prevouts: !this.omitHistoryPrevouts }))
        )
      }
    } else if ((match = path.match(/^\/address\/([^/]+)\/txs$/))) {
      const history = this.history(decodeURIComponent(match[1]!))
      const after = url.searchParams.get('after_txid')
      const start = after ? history.findIndex(tx => tx.txid === after) + 1 : 0
      if (after && start === 0) return new Response('after_txid not found', { status: 422 })
      if (
        this.emptyPageAfterLastMempoolRow &&
        after &&
        history[start - 1]!.height === undefined &&
        history[start]?.height !== undefined
      ) {
        return json([])
      }
      return json(
        history
          .slice(start, start + MEMPOOL_QBIT_PAGE)
          .map(tx => this.esploraTx(tx, { prevouts: !this.omitHistoryPrevouts }))
      )
    }
    return notFound()
  }

  private acceptBroadcast(rawHex: string): Response {
    let tx: transactionCore.Transaction
    try {
      tx = transactionCore.Transaction.fromHex(rawHex)
    } catch {
      return new Response('TX decode failed', { status: 400 })
    }
    const txid = tx.getId()
    // As qbit Core's sendrawtransaction: a transaction it already holds is
    // no conflict with itself. One in the mempool is answered with its txid
    // again, and a confirmed one as already known (-27).
    const known = this.txs.get(txid)
    if (known) {
      return known.height === undefined
        ? new Response(txid, { status: 200 })
        : new Response(
            'sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}',
            { status: 400 }
          )
    }
    const inputs = tx.ins.map(input => ({
      txid: Buffer.from(input.hash).reverse().toString('hex'),
      vout: input.index,
    }))
    for (const input of inputs) {
      const spender = this.spenderOf(input.txid, input.vout)
      if (!this.txs.get(input.txid)?.outputs[input.vout]) {
        return new Response('sendrawtransaction RPC error: bad-txns-inputs-missingorspent', {
          status: 400,
        })
      }
      if (spender) {
        if (!this.acceptReplacements || spender.height !== undefined) {
          return new Response('sendrawtransaction RPC error: txn-mempool-conflict', {
            status: 400,
          })
        }
        this.removeTx(spender.txid)
      }
    }
    this.rawHex.set(txid, rawHex)
    this.addTx({
      txid,
      inputs,
      outputs: tx.outs.map(output => {
        const script = Buffer.from(output.script).toString('hex')
        const address = this.addresses.get(script)
        return { ...(address ? { address } : {}), script, value: Number(output.value) }
      }),
    })
    return new Response(txid, { status: 200 })
  }
}

// A constructed Response has no URL; the clients name it in their errors.
function withUrl(response: Response, url: URL): Response {
  Object.defineProperty(response, 'url', { value: url.toString() })
  return response
}

/** A 64-hex txid unique to `seed`. */
export function fakeTxid(seed: number, salt = 0): string {
  return (seed * 7_919 + salt + 1).toString(16).padStart(64, '0')
}
