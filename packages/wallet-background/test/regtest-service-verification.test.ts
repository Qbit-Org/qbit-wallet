import { describe, expect, it, vi } from 'vitest'

import { QBIT_REGTEST_GENESIS_HASH, QBIT_REGTEST_ORIGIN } from '@qbit/wallet-shared'
import { verifyRegtestService } from '../src/utils/regtest-service-verification'

const GENESIS = QBIT_REGTEST_GENESIS_HASH
// Regtest genesis of a different chain family: must never pass the identity check.
const FOREIGN_REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'

function textResponse(
  body: string,
  init: {
    status?: number
    contentType?: string | null
    url?: string
    headers?: Record<string, string>
  } = {}
): Response {
  const headers = new Headers(init.headers ?? {})
  const status = init.status ?? 200
  if (init.contentType !== null) {
    headers.set('content-type', init.contentType ?? 'text/plain')
  }
  // A string body would auto-set text/plain; a typeless Blob keeps the header
  // absent. Null-body statuses must not carry a body at all.
  const responseBody =
    body === '' && [204, 205, 304].includes(status)
      ? null
      : init.contentType === null
        ? new Blob([body], { type: '' })
        : body
  const response = new Response(responseBody, { status, headers })
  if (init.url !== undefined) {
    Object.defineProperty(response, 'url', { value: init.url })
  }
  return response
}

function routeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const path = url.slice(QBIT_REGTEST_ORIGIN.length)
    const handler = routes[path]
    if (!handler) throw new TypeError(`unexpected route ${path}`)
    return handler()
  })
  return { fetch, calls }
}

describe('verifyRegtestService', () => {
  it('accepts the pinned genesis identity plus a sane tip height using bounded read-only requests', async () => {
    const { fetch, calls } = routeFetch({
      '/block-height/0': () => textResponse(`${GENESIS}\n`),
      '/blocks/tip/height': () => textResponse('12'),
    })

    const result = await verifyRegtestService({ fetch, now: () => 1234 })

    expect(result).toEqual({ ok: true, tipHeight: 12, verifiedAt: 1234 })
    expect(calls.map(call => call.url)).toEqual([
      `${QBIT_REGTEST_ORIGIN}/block-height/0`,
      `${QBIT_REGTEST_ORIGIN}/blocks/tip/height`,
    ])
    for (const { init } of calls) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
      expect(init?.body).toBeUndefined()
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('only ever contacts the hard-coded loopback origin', async () => {
    const { fetch, calls } = routeFetch({
      '/block-height/0': () => textResponse(GENESIS),
      '/blocks/tip/height': () => textResponse('0'),
    })
    await verifyRegtestService({ fetch })
    for (const { url } of calls) {
      expect(new URL(url).origin).toBe('http://127.0.0.1:3002')
    }
  })

  it('rejects a foreign-chain or otherwise wrong genesis hash without probing further', async () => {
    const { fetch, calls } = routeFetch({
      '/block-height/0': () => textResponse(FOREIGN_REGTEST_GENESIS),
      '/blocks/tip/height': () => textResponse('12'),
    })

    await expect(verifyRegtestService({ fetch })).resolves.toEqual({
      ok: false,
      state: 'unexpected_service',
      reason: 'genesis_mismatch',
    })
    expect(calls).toHaveLength(1)
  })

  it('treats redirects (manual 3xx, opaque, or a foreign final origin) as an unexpected service', async () => {
    const cases: Array<() => Response> = [
      () =>
        textResponse('', {
          status: 302,
          headers: { location: 'http://127.0.0.1:3003/block-height/0' },
        }),
      () => {
        const response = new Response(null, { status: 200 })
        Object.defineProperty(response, 'type', { value: 'opaqueredirect' })
        return response
      },
      () => textResponse(GENESIS, { url: 'http://127.0.0.1:3003/block-height/0' }),
      () => textResponse(GENESIS, { url: 'http://localhost:3002/block-height/0' }),
    ]
    for (const identity of cases) {
      const { fetch } = routeFetch({ '/block-height/0': identity })
      await expect(verifyRegtestService({ fetch })).resolves.toEqual({
        ok: false,
        state: 'unexpected_service',
        reason: 'redirect',
      })
    }
  })

  it('reports a timeout as unreachable', async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )

    await expect(verifyRegtestService({ fetch, timeoutMs: 5 })).resolves.toEqual({
      ok: false,
      state: 'unreachable',
      reason: 'timeout',
    })
  })

  it('reports connection failures as unreachable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(verifyRegtestService({ fetch })).resolves.toEqual({
      ok: false,
      state: 'unreachable',
      reason: 'network_error',
    })
  })

  it('reports a missing fetch implementation as unreachable instead of throwing', async () => {
    const original = globalThis.fetch
    // @ts-expect-error - simulate a runtime without fetch
    globalThis.fetch = undefined
    try {
      await expect(verifyRegtestService()).resolves.toEqual({
        ok: false,
        state: 'unreachable',
        reason: 'network_error',
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('rejects malformed, non-text, JSON, and oversized identity bodies', async () => {
    const cases: Array<[() => Response, string]> = [
      [() => textResponse('not a hash'), 'malformed'],
      [() => textResponse(GENESIS.slice(0, 63)), 'malformed'],
      [() => textResponse(`"${GENESIS}"`, { contentType: 'application/json' }), 'content_type'],
      [() => textResponse(`<html>${GENESIS}</html>`, { contentType: 'text/html' }), 'content_type'],
      [() => textResponse(GENESIS, { contentType: null }), 'content_type'],
      [() => textResponse(`${GENESIS}${'a'.repeat(300)}`), 'oversized'],
      [() => textResponse(GENESIS, { headers: { 'content-length': '999999' } }), 'oversized'],
    ]
    for (const [identity, reason] of cases) {
      const { fetch } = routeFetch({ '/block-height/0': identity })
      await expect(verifyRegtestService({ fetch, maxBodyBytes: 256 })).resolves.toEqual({
        ok: false,
        state: 'unexpected_service',
        reason,
      })
    }
  })

  it('stops reading a streamed body once the size limit is exceeded', async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new TextEncoder().encode('f'.repeat(64)))
      },
    })
    const fetch = vi.fn(async () => {
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
    })

    await expect(verifyRegtestService({ fetch, maxBodyBytes: 200 })).resolves.toEqual({
      ok: false,
      state: 'unexpected_service',
      reason: 'oversized',
    })
    expect(pulls).toBeLessThan(10)
  })

  it('maps 404/5xx to unreachable and other non-200 statuses to an unexpected service', async () => {
    for (const [status, state] of [
      [404, 'unreachable'],
      [503, 'unreachable'],
      [401, 'unexpected_service'],
      [204, 'unexpected_service'],
    ] as const) {
      const { fetch } = routeFetch({ '/block-height/0': () => textResponse('', { status }) })
      await expect(verifyRegtestService({ fetch })).resolves.toEqual({
        ok: false,
        state,
        reason: 'http_status',
      })
    }
  })

  it('requires the tip-height route the wallet depends on to answer sensibly', async () => {
    const tipCases: Array<[() => Response, 'unreachable' | 'unexpected_service', string]> = [
      [() => textResponse('abc'), 'unexpected_service', 'tip_unavailable'],
      [() => textResponse('-1'), 'unexpected_service', 'tip_unavailable'],
      [() => textResponse('007'), 'unexpected_service', 'tip_unavailable'],
      [
        () => textResponse('{"height":1}', { contentType: 'application/json' }),
        'unexpected_service',
        'tip_unavailable',
      ],
      [() => textResponse('', { status: 500 }), 'unreachable', 'http_status'],
    ]
    for (const [tip, state, reason] of tipCases) {
      const { fetch } = routeFetch({
        '/block-height/0': () => textResponse(GENESIS),
        '/blocks/tip/height': tip,
      })
      await expect(verifyRegtestService({ fetch })).resolves.toEqual({ ok: false, state, reason })
    }
  })

  it('never includes response bodies in its result', async () => {
    const secret = 'qbrt1qsecretaddressthatmustnotleak'
    const { fetch } = routeFetch({ '/block-height/0': () => textResponse(secret) })
    const result = await verifyRegtestService({ fetch })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})
