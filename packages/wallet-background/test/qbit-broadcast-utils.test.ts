import { describe, expect, it } from 'vitest'

import { QbitApiError } from '@qbit-oss/api'
import { QBIT_BROADCAST_DETAIL_MAX_LENGTH, sanitizeQbitBroadcastDetail } from '@qbit/wallet-shared'
import {
  QbitBroadcastResponseMismatchError,
  classifyQbitBroadcastError,
  isQbitBroadcastResendable,
  isQbitTxSizeBroadcastRejection,
  qbitBroadcastRejection,
  qbitBroadcastRejectionDetail,
} from '../src/utils/qbit-broadcast'

const ENDPOINT = 'http://127.0.0.1:3002/tx'

describe('sanitizeQbitBroadcastDetail', () => {
  it('strips endpoint URLs, bare host:port fragments, and txid-sized hex blobs', () => {
    const detail = sanitizeQbitBroadcastDetail(
      `network error: ${ENDPOINT} (TypeError: fetch failed) via 10.0.0.2:8080 tx ${'ab'.repeat(40)}`
    )
    expect(detail).toBe('network error: [url] (TypeError: fetch failed) via [host] tx [hex]')
    expect(detail).not.toContain('127.0.0.1')
    expect(detail).not.toContain('3002')
    expect(detail).not.toContain('ab'.repeat(40))
  })

  it('caps the detail length and drops empty or object-only input', () => {
    const long = sanitizeQbitBroadcastDetail('x'.repeat(500))
    expect(long).toHaveLength(QBIT_BROADCAST_DETAIL_MAX_LENGTH)
    expect(long?.endsWith('...')).toBe(true)
    expect(sanitizeQbitBroadcastDetail('   ')).toBeUndefined()
    expect(sanitizeQbitBroadcastDetail(undefined)).toBeUndefined()
    expect(sanitizeQbitBroadcastDetail({ message: 'x' })).toBeUndefined()
    expect(sanitizeQbitBroadcastDetail(String({}))).toBeUndefined()
  })
})

describe('qbitBroadcastRejectionDetail', () => {
  it('unwraps esplora plain-text bodies with an embedded RPC error', () => {
    expect(
      qbitBroadcastRejectionDetail(
        'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 100 < 110"}'
      )
    ).toBe('min relay fee not met, 100 < 110')
  })

  it('unwraps mempool-qbit JSON bodies in their known shapes', () => {
    expect(qbitBroadcastRejectionDetail('"bad-txns-inputs-missingorspent"')).toBe(
      'bad-txns-inputs-missingorspent'
    )
    expect(qbitBroadcastRejectionDetail('{"error":"Failed to send transaction"}')).toBe(
      'Failed to send transaction'
    )
    expect(
      qbitBroadcastRejectionDetail(
        '{"error":{"code":-27,"message":"Transaction already in block chain"}}'
      )
    ).toBe('Transaction already in block chain')
    expect(qbitBroadcastRejectionDetail('{"message":"dust"}')).toBe('dust')
  })

  it('captures the node RPC code from every known envelope and ignores proxy-style codes', () => {
    expect(
      qbitBroadcastRejection('sendrawtransaction RPC error: {"code":-26,"message":"dust"}')
    ).toEqual({ message: 'dust', code: -26 })
    expect(qbitBroadcastRejection('sendrawtransaction RPC error: {"code":-26}')).toEqual({
      message: '',
      code: -26,
    })
    expect(
      qbitBroadcastRejection(
        JSON.stringify({
          error: 'sendrawtransaction RPC error: {"code":-25,"message":"missing-inputs"}',
        })
      )
    ).toEqual({ message: 'missing-inputs', code: -25 })
    expect(
      qbitBroadcastRejection(
        '{"error":{"code":-27,"message":"Transaction already in block chain"}}'
      )
    ).toEqual({ message: 'Transaction already in block chain', code: -27 })
    expect(qbitBroadcastRejection('{"error":{"code":400,"message":"Bad Request"}}')).toEqual({
      message: 'Bad Request',
    })
    expect(qbitBroadcastRejection('{"code":400,"message":"Bad Request"}')).toEqual({
      message: 'Bad Request',
    })
    expect(qbitBroadcastRejection('<html><body>400 Bad Request</body></html>')).toEqual({
      message: '<html><body>400 Bad Request</body></html>',
    })
  })
})

describe('classifyQbitBroadcastError', () => {
  const rejection = (body: string) =>
    new QbitApiError('http', `HTTP 400 from ${ENDPOINT}: ${body}`, {
      status: 400,
      url: ENDPOINT,
      responseBody: body,
    })

  it('treats a concrete node rejection as definitive with a sanitized detail', () => {
    const classification = classifyQbitBroadcastError(
      rejection(
        'sendrawtransaction RPC error: {"code":-26,"message":"bad-txns-inputs-missingorspent"}'
      )
    )
    expect(classification).toEqual({
      reason: 'rejected',
      definitiveRejection: true,
      detail: 'HTTP 400: bad-txns-inputs-missingorspent',
    })
    expect(classification.detail).not.toContain('127.0.0.1')
  })

  it.each([
    ['already in mempool', 'txn-already-in-mempool'],
    ['already known', 'txn-already-known'],
    ['already in chain', '{"error":{"code":-27,"message":"Transaction already in block chain"}}'],
  ])(
    'never treats a 400 %s answer as a rejection: the node has the transaction',
    (_label, body) => {
      const classification = classifyQbitBroadcastError(rejection(body))
      expect(classification.reason).toBe('rejected')
      expect(classification.definitiveRejection).toBe(false)
    }
  )

  it('treats the generic mempool-qbit failure body as a service error, never as a rejection', () => {
    expect(classifyQbitBroadcastError(rejection('{"error":"Failed to send transaction"}'))).toEqual(
      {
        reason: 'server',
        definitiveRejection: false,
        detail: 'HTTP 400: Failed to send transaction',
      }
    )
    expect(classifyQbitBroadcastError(rejection('Unable to submit raw transaction'))).toEqual({
      reason: 'server',
      definitiveRejection: false,
      detail: 'HTTP 400: Unable to submit raw transaction',
    })
  })

  it.each([
    ['empty', ''],
    ['html', '<html><head><title>400 Bad Request</title></head><body>nginx</body></html>'],
    [
      'doctype',
      '<!DOCTYPE html><html><body><h1>Bad Request</h1><p>Blocked by proxy</p></body></html>',
    ],
    ['plain proxy text', 'Bad Request'],
    ['cloud gateway', 'Request blocked by the gateway policy (ref 5f1a)'],
    ['json proxy', '{"error":"Forbidden"}'],
    ['json proxy with http code', '{"error":{"code":400,"message":"Bad Request"}}'],
    ['json message with http code', '{"code":400,"message":"invalid request"}'],
    ['bare txid', 'ab'.repeat(32)],
    ['unrelated already', 'You have already exceeded your quota'],
  ])(
    'keeps an unrecognized 400 %s body inconclusive and out of the support detail',
    (_label, body) => {
      const error = body
        ? rejection(body)
        : new QbitApiError('http', `HTTP 400 from ${ENDPOINT}`, { status: 400, url: ENDPOINT })
      expect(classifyQbitBroadcastError(error)).toEqual({
        reason: 'server',
        definitiveRejection: false,
        detail: 'HTTP 400',
      })
    }
  )

  it.each([
    [
      'esplora RPC -25 envelope',
      'sendrawtransaction RPC error: {"code":-25,"message":"Missing inputs"}',
      'HTTP 400: Missing inputs',
    ],
    [
      'esplora RPC -26 envelope with an unlisted reason',
      'sendrawtransaction RPC error: {"code":-26,"message":"p2mr-policy-v2-violation"}',
      'HTTP 400: p2mr-policy-v2-violation',
    ],
    [
      'esplora RPC -26 envelope without a message',
      'sendrawtransaction RPC error: {"code":-26}',
      'HTTP 400: RPC error -26',
    ],
    [
      'structured RPC envelope',
      JSON.stringify({
        error: 'sendrawtransaction RPC error: {"code":-26,"message":"txn-mempool-conflict"}',
      }),
      'HTTP 400: txn-mempool-conflict',
    ],
    [
      'mempool-qbit string reason',
      '"bad-txns-inputs-missingorspent"',
      'HTTP 400: bad-txns-inputs-missingorspent',
    ],
    ['mempool-qbit message reason', '{"message":"dust"}', 'HTTP 400: dust'],
    [
      'plain reject reason',
      'min relay fee not met, 100 < 110',
      'HTTP 400: min relay fee not met, 100 < 110',
    ],
    [
      'script failure with detail',
      'mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)',
      'HTTP 400: mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)',
    ],
    ['decode failure', 'TX decode failed', 'HTTP 400: TX decode failed'],
    ['single-word reason', 'dust', 'HTTP 400: dust'],
  ])('treats %s as a definitive node rejection', (_label, body, detail) => {
    expect(classifyQbitBroadcastError(rejection(body))).toEqual({
      reason: 'rejected',
      definitiveRejection: true,
      detail,
    })
  })

  it.each([
    [
      'a miscellaneous RPC -1 envelope',
      'sendrawtransaction RPC error: {"code":-1,"message":"unexpected"}',
    ],
    ['a warming-up RPC -28 envelope', '{"error":{"code":-28,"message":"Loading block index..."}}'],
    ['a single-word reason inside other text', 'the proxy rejected dust in your request'],
    ['a version word inside other text', 'Unsupported API version'],
  ])('never treats %s as definitive', (_label, body) => {
    const classification = classifyQbitBroadcastError(rejection(body))
    expect(classification.definitiveRejection).toBe(false)
  })

  it('classifies a reply past the size limit as an unusable answer, not an unexpected error', () => {
    const tooLarge = new QbitApiError(
      'response_too_large',
      'HTTP 200 reply from https://explorer.test/.../tx/abc/outspends exceeded 67108864 bytes; its body was discarded',
      { status: 200 }
    )

    const classification = classifyQbitBroadcastError(tooLarge)
    expect(classification).toMatchObject({ reason: 'invalid_response', definitiveRejection: false })
    expect(classification.detail).not.toContain('explorer.test')
  })

  it('classifies a non-echoing 2xx answer as inconclusive with a fixed, body-free detail', () => {
    expect(classifyQbitBroadcastError(new QbitBroadcastResponseMismatchError())).toEqual({
      reason: 'invalid_response',
      definitiveRejection: false,
      detail: 'broadcast response did not echo the expected transaction id',
    })
  })

  it('keeps a hostile reason body sanitized in the detail', () => {
    const classification = classifyQbitBroadcastError(
      rejection(`bad-txns-inputs-missingorspent see ${ENDPOINT} tx ${'ab'.repeat(32)}`)
    )
    expect(classification.definitiveRejection).toBe(true)
    expect(classification.detail).toBe(
      'HTTP 400: bad-txns-inputs-missingorspent see [url] tx [hex]'
    )
  })

  it.each([
    [
      'network',
      new QbitApiError('network', `network error: ${ENDPOINT} (TypeError: fetch failed)`, {
        url: ENDPOINT,
      }),
      'network',
      'network error: [url] (TypeError: fetch failed)',
    ],
    [
      'timeout',
      new QbitApiError('timeout', `request timed out after 15000ms: ${ENDPOINT}`, {
        url: ENDPOINT,
      }),
      'timeout',
      'request timed out after 15000ms: [url]',
    ],
    [
      'parse',
      new QbitApiError('parse', `failed to read response body from ${ENDPOINT}`, {
        url: ENDPOINT,
      }),
      'invalid_response',
      'failed to read response body from [url]',
    ],
    [
      'server 502',
      new QbitApiError('http', `HTTP 502 from ${ENDPOINT}: <html>Bad gateway</html>`, {
        status: 502,
        url: ENDPOINT,
        responseBody: '<html>Bad gateway</html>',
      }),
      'server',
      'http HTTP 502',
    ],
    [
      'rate limit',
      new QbitApiError('rate_limit', `HTTP 429 from ${ENDPOINT}`, { status: 429, url: ENDPOINT }),
      'server',
      'rate_limit HTTP 429',
    ],
    [
      'payload too large',
      new QbitApiError('payload_too_large', `HTTP 413 from ${ENDPOINT}`, {
        status: 413,
        url: ENDPOINT,
      }),
      'server',
      'payload_too_large HTTP 413',
    ],
    [
      'missing endpoint',
      new QbitApiError('not_found', `HTTP 404 from ${ENDPOINT}`, { status: 404, url: ENDPOINT }),
      'server',
      'not_found HTTP 404',
    ],
    [
      'an unknown outcome after a timeout',
      new QbitApiError('unknown_outcome', `transaction submission outcome unknown (${ENDPOINT})`, {
        url: ENDPOINT,
        cause: new QbitApiError('timeout', `request timed out after 15000ms: ${ENDPOINT}`, {
          url: ENDPOINT,
        }),
      }),
      'timeout',
      'request timed out after 15000ms: [url]',
    ],
    [
      'an unknown outcome after a possibly-sent network error',
      new QbitApiError('unknown_outcome', `transaction submission outcome unknown (${ENDPOINT})`, {
        url: ENDPOINT,
        cause: new QbitApiError('network', `network error: ${ENDPOINT} (TypeError: fetch failed)`, {
          url: ENDPOINT,
        }),
      }),
      'network',
      'network error: [url] (TypeError: fetch failed)',
    ],
    [
      'an unknown outcome after a 5xx without a node verdict',
      new QbitApiError('unknown_outcome', `HTTP 502 from ${ENDPOINT}: <html>Bad gateway</html>`, {
        status: 502,
        url: ENDPOINT,
        responseBody: '<html>Bad gateway</html>',
      }),
      'server',
      'unknown_outcome HTTP 502',
    ],
    [
      'an unknown outcome after a 2xx that is not a txid',
      new QbitApiError('unknown_outcome', `reply is not a txid (HTTP 200 from ${ENDPOINT}: ok)`, {
        status: 200,
        url: ENDPOINT,
        responseBody: 'ok',
      }),
      'invalid_response',
      'unknown_outcome HTTP 200',
    ],
    [
      'plain error',
      new Error(`socket hang up at ${ENDPOINT}`),
      'unexpected',
      'socket hang up at [url]',
    ],
    ['non-error', 'boom', 'unexpected', 'boom'],
    ['empty', undefined, 'unexpected', undefined],
  ])('classifies %s as inconclusive', (_label, error, reason, detail) => {
    const classification = classifyQbitBroadcastError(error)
    expect(classification.reason).toBe(reason)
    expect(classification.definitiveRejection).toBe(false)
    expect(classification.detail).toBe(detail)
    expect(classification.detail ?? '').not.toContain('127.0.0.1')
    expect(classification.detail ?? '').not.toContain('<html>')
  })
})

describe('isQbitBroadcastResendable', () => {
  const unknownOutcome = (options: ConstructorParameters<typeof QbitApiError>[2] = {}) =>
    new QbitApiError('unknown_outcome', `transaction submission outcome unknown (${ENDPOINT})`, {
      url: ENDPOINT,
      ...options,
    })
  const timeout = new QbitApiError('timeout', `request timed out after 15000ms: ${ENDPOINT}`)

  it.each([
    ['a timeout after sending', unknownOutcome({ cause: timeout })],
    [
      'a connection lost after sending',
      unknownOutcome({ cause: new QbitApiError('network', 'network error') }),
    ],
    ['a 5xx without the node verdict', unknownOutcome({ status: 502 })],
    ['a 2xx that is not the txid', unknownOutcome({ status: 200 })],
    [
      'a reply body that could not be read',
      unknownOutcome({ status: 200, cause: new QbitApiError('parse', 'failed to read') }),
    ],
    ['a connection that never opened', new QbitApiError('network', 'getaddrinfo ENOTFOUND')],
    ['a 2xx echoing another txid', new QbitBroadcastResponseMismatchError()],
  ])('sends the same bytes again after %s', (_label, error) => {
    expect(isQbitBroadcastResendable(error)).toBe(true)
  })

  it.each([
    [
      'a definitive node rejection',
      new QbitApiError('http', 'HTTP 400', {
        status: 400,
        responseBody: '{"code":-26,"message":"min relay fee not met"}',
      }),
    ],
    [
      'a node rejection relayed as a 5xx',
      new QbitApiError('http', 'HTTP 500', {
        status: 500,
        responseBody: '{"code":-25,"message":"bad-txns-inputs-missingorspent"}',
      }),
    ],
    ['a proxy 400', new QbitApiError('http', 'HTTP 400', { status: 400, responseBody: 'Bad' })],
    ['a 429', new QbitApiError('rate_limit', 'HTTP 429', { status: 429, retryAfterMs: 60_000 })],
    ['a missing route', new QbitApiError('not_found', 'HTTP 404', { status: 404 })],
    ['a body too large', new QbitApiError('payload_too_large', 'HTTP 413', { status: 413 })],
    [
      'a refused redirect',
      unknownOutcome({
        status: 307,
        cause: new QbitApiError('http', 'HTTP 307 redirect refused', { status: 307 }),
      }),
    ],
    [
      'a redirect the runtime followed',
      unknownOutcome({ cause: new QbitApiError('http', 'fetch followed a redirect') }),
    ],
    ['a cancelled call', unknownOutcome({ cause: new QbitApiError('aborted', 'request aborted') })],
    [
      'a cause it does not know',
      unknownOutcome({ cause: new QbitApiError('rate_limit', 'HTTP 429', { status: 429 }) }),
    ],
    ['a cause that is not an API error', unknownOutcome({ cause: new Error('teardown') })],
    ['a deadline before sending', timeout],
    ['an unexpected throw', new Error('socket hang up')],
  ])('never sends again after %s', (_label, error) => {
    expect(isQbitBroadcastResendable(error)).toBe(false)
  })
})

describe('isQbitTxSizeBroadcastRejection', () => {
  const rejection = (status: number, responseBody: string) =>
    new QbitApiError('http', `HTTP ${status} from ${ENDPOINT}`, { status, responseBody })

  it.each([
    ['esplora', 'sendrawtransaction RPC error: {"code":-26,"message":"tx-size"}'],
    ['mempool-qbit', '{"error":{"code":-26,"message":"tx-size"}}'],
    ['bare', 'tx-size'],
    ['coded older format', '{"code":-26,"message":"64: tx-size"}'],
  ])('recognizes a %s tx-size rejection', (_label, body) => {
    expect(isQbitTxSizeBroadcastRejection(rejection(400, body))).toBe(true)
  })

  it.each([
    // Re-planning rebuilds about the same output, so dust is not re-planned.
    ['a dust output', rejection(400, '{"error":{"code":-26,"message":"dust"}}')],
    [
      'a mempool-dependent reason',
      rejection(400, '{"code":-26,"message":"mempool min fee not met"}'),
    ],
    ['spent inputs', rejection(400, '{"code":-25,"message":"bad-txns-inputs-missingorspent"}')],
    ['a different size reason', rejection(400, '{"code":-26,"message":"tx-size-small"}')],
    [
      'an acceptance',
      rejection(400, '{"code":-27,"message":"Transaction already in block chain"}'),
    ],
    ['a proxy page', rejection(400, '<html>tx-size</html>')],
    ['a server error', rejection(500, 'tx-size')],
    ['a timeout', new QbitApiError('timeout', 'request timed out')],
    ['a plain error', new Error('tx-size')],
  ])('does not treat %s as tx-size', (_label, error) => {
    expect(isQbitTxSizeBroadcastRejection(error)).toBe(false)
  })
})
