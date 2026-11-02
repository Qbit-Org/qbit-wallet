import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import { createMockEsplora, type MockBackend, type MockFault } from '@qbit-oss/api/testing'
import { QbitWalletEsploraClient, QbitWalletMempoolClient } from '../src/utils/qbit-api'
import { classifyQbitBroadcastError, isQbitBroadcastResendable } from '../src/utils/qbit-broadcast'
import { QBIT_EXPLORER_MAX_BODY_BYTES } from '../src/utils/qbit-explorer-fetch'

// The submission outcomes of @qbit-oss/api's own client, read through the
// wallet's clients (and so its explorer fetch) from the package's mock of each
// backend: the wallet must never take a submission that may have reached the
// node for one that did not.

// Version 2, one input, one P2MR output, no witness: bytes the mock decodes.
const RAW_TX = [
  '02000000',
  '01',
  '11'.repeat(32),
  '00000000',
  '00',
  'ffffffff',
  '01',
  '50c3000000000000',
  '22',
  `5220${'aa'.repeat(32)}`,
  '00000000',
].join('')
const TXID = Buffer.from(
  createHash('sha256')
    .update(createHash('sha256').update(Buffer.from(RAW_TX, 'hex')).digest())
    .digest()
)
  .reverse()
  .toString('hex')

function walletClient(backend: MockBackend, faults: MockFault[]) {
  const mock = createMockEsplora({ backend, faults })
  const options = { baseUrl: mock.baseUrl, fetchFn: mock.fetchFn, retryBaseDelayMs: 0 }
  const client =
    backend === 'mempool-qbit'
      ? new QbitWalletMempoolClient(options)
      : new QbitWalletEsploraClient(options)
  const posts = () => mock.requests.filter(request => request.method === 'POST').length
  return { client, posts }
}

async function broadcastError(client: { broadcastTx(hex: string): Promise<string> }) {
  const error = await client.broadcastTx(RAW_TX).then(
    () => undefined,
    (reason: unknown) => reason
  )
  if (!QbitApiError.is(error)) throw new Error(`expected a QbitApiError, got ${String(error)}`)
  return error
}

describe.each(['esplora', 'mempool-qbit'] as const)('broadcast outcomes on %s', backend => {
  it('keeps a transaction the node took, whose reply was lost, unknown until a lookup finds it', async () => {
    const { client, posts } = walletClient(backend, [
      { route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' },
    ])

    const error = await broadcastError(client)

    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: TXID })
    expect(classifyQbitBroadcastError(error)).toMatchObject({
      reason: 'network',
      definitiveRejection: false,
    })
    expect(isQbitBroadcastResendable(error)).toBe(true)
    expect(posts()).toBe(1)
    // The lifecycle lookup the wallet makes next finds it.
    await expect(client.getTx(TXID)).resolves.toMatchObject({ txid: TXID })
  })

  it('keeps a 2xx reply that is not the txid unknown', async () => {
    const { client, posts } = walletClient(backend, [
      { route: 'POST /tx', kind: 'status', status: 200, body: '<html>ok</html>' },
    ])

    const error = await broadcastError(client)

    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 200 })
    expect(classifyQbitBroadcastError(error)).toEqual({
      reason: 'invalid_response',
      definitiveRejection: false,
      detail: 'unknown_outcome HTTP 200',
    })
    expect(isQbitBroadcastResendable(error)).toBe(true)
    expect(posts()).toBe(1)
  })

  it('keeps a 429 relaying the backend’s lost node connection unknown, without sending it again', async () => {
    const { client, posts } = walletClient(backend, [
      { route: 'POST /tx', kind: 'status', status: 429, body: '{"code":"ETIMEDOUT"}', times: 3 },
    ])

    const error = await broadcastError(client)

    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 429 })
    // The verdict comes from the kind and status, never the message's wording.
    expect(classifyQbitBroadcastError(error)).toEqual({
      reason: 'server',
      definitiveRejection: false,
      detail: 'unknown_outcome HTTP 429',
    })
    // The wallet may send the same bytes again once its lookup misses them.
    expect(isQbitBroadcastResendable(error)).toBe(true)
    expect(posts()).toBe(1)
  })

  it('takes a 429 saying the node already has the transaction as sent', async () => {
    const { client, posts } = walletClient(backend, [
      {
        route: 'POST /tx',
        kind: 'status',
        status: 429,
        body: 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
      },
    ])

    await expect(client.broadcastTx(RAW_TX)).resolves.toBe(TXID)
    expect(posts()).toBe(1)
  })

  it('still reports the node’s own rejection as definitive', async () => {
    const { client } = walletClient(backend, [
      {
        route: 'POST /tx',
        kind: 'broadcast',
        outcome: 'rejected',
        code: -26,
        message: 'bad-txns-inputs-missingorspent',
      },
    ])

    const error = await broadcastError(client)

    expect(error).toMatchObject({ kind: 'http', status: 400 })
    expect(classifyQbitBroadcastError(error)).toMatchObject({
      reason: 'rejected',
      definitiveRejection: true,
    })
    expect(isQbitBroadcastResendable(error)).toBe(false)
  })
})

describe('the explorer clients’ response size limit', () => {
  const LIMIT = 64 * 1024

  // A streamed reply without end, as every real fetch answers: the wallet's
  // fetch buffers it, up to the client's limit.
  function endlessReply(status = 200) {
    const chunk = new Uint8Array(16 * 1024)
    const state = { sentBytes: 0, cancelled: false }
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          state.sentBytes += chunk.byteLength
          stream.enqueue(chunk)
        },
        cancel() {
          state.cancelled = true
        },
      })
      const response = new Response(body, { status })
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    })
    return {
      fetchFn: fetchFn as unknown as typeof fetch,
      calls: () => fetchFn.mock.calls.length,
      state,
    }
  }

  // A reply the wallet's fetch cannot buffer (it has no stream body), whose
  // whole body the client measures before reading it.
  function unbufferedReply(size: number, text: string) {
    return vi.fn(async (input: RequestInfo | URL) => ({
      status: 200,
      ok: true,
      redirected: false,
      type: 'basic',
      url: String(input),
      headers: new Headers(),
      body: null,
      blob: async () => ({ size, text: async () => text }),
    })) as unknown as typeof fetch
  }

  it.each([
    ['esplora', QbitWalletEsploraClient],
    ['mempool-qbit', QbitWalletMempoolClient],
  ] as const)(
    'reaches the %s client as the wallet builds it, and an explicit one wins',
    (_surface, Client) => {
      const limitOf = (client: object) => (client as { maxResponseBytes?: number }).maxResponseBytes
      expect(limitOf(new Client({ baseUrl: 'https://explorer.test/api' }))).toBe(
        QBIT_EXPLORER_MAX_BODY_BYTES
      )
      expect(
        limitOf(new Client({ baseUrl: 'https://explorer.test/api', maxResponseBytes: 1_024 }))
      ).toBe(1_024)
    }
  )

  it.each([200, 503])(
    'fails a streamed %s reply past a configured limit as too large, without trying again',
    async status => {
      const reply = endlessReply(status)
      const client = new QbitWalletEsploraClient({
        baseUrl: 'https://explorer.test/api',
        fetchFn: reply.fetchFn,
        maxResponseBytes: LIMIT,
      })

      await expect(client.getTipHeight()).rejects.toMatchObject({
        kind: 'response_too_large',
        status,
      })
      expect(reply.calls()).toBe(1)
      expect(reply.state.cancelled).toBe(true)
      expect(reply.state.sentBytes).toBeLessThanOrEqual(LIMIT + 32 * 1024)
    }
  )

  it('keeps a submission whose streamed reply passes the limit unknown, and does not send it again', async () => {
    const reply = endlessReply()
    const client = new QbitWalletEsploraClient({
      baseUrl: 'https://explorer.test/api',
      fetchFn: reply.fetchFn,
      maxResponseBytes: LIMIT,
    })

    const error = await broadcastError(client)

    expect(error.kind).toBe('unknown_outcome')
    expect(QbitApiError.is(error.cause) && error.cause.kind).toBe('response_too_large')
    expect(classifyQbitBroadcastError(error).definitiveRejection).toBe(false)
    expect(isQbitBroadcastResendable(error)).toBe(false)
    expect(reply.calls()).toBe(1)
  })

  it('reads a reply at the limit, and fails one past it without trying again', async () => {
    const atLimit = unbufferedReply(QBIT_EXPLORER_MAX_BODY_BYTES, '812')
    await expect(
      new QbitWalletEsploraClient({
        baseUrl: 'https://explorer.test/api',
        fetchFn: atLimit,
      }).getTipHeight()
    ).resolves.toBe(812)

    const pastLimit = unbufferedReply(QBIT_EXPLORER_MAX_BODY_BYTES + 1, '812')
    const client = new QbitWalletEsploraClient({
      baseUrl: 'https://explorer.test/api',
      fetchFn: pastLimit,
    })
    await expect(client.getTipHeight()).rejects.toMatchObject({ kind: 'response_too_large' })
    expect(pastLimit).toHaveBeenCalledTimes(1)
  })

  it('keeps a submission whose reply passes the limit unknown, and does not send it again', async () => {
    const pastLimit = unbufferedReply(QBIT_EXPLORER_MAX_BODY_BYTES + 1, TXID)
    const client = new QbitWalletEsploraClient({
      baseUrl: 'https://explorer.test/api',
      fetchFn: pastLimit,
    })

    const error = await broadcastError(client)

    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 200 })
    expect(QbitApiError.is(error.cause) && error.cause.kind).toBe('response_too_large')
    expect(classifyQbitBroadcastError(error).definitiveRejection).toBe(false)
    expect(isQbitBroadcastResendable(error)).toBe(false)
    expect(pastLimit).toHaveBeenCalledTimes(1)
  })
})
