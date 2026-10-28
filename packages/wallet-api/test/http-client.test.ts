import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HttpClient } from '../src/client/http-client'
import { ApiClientError, RateLimitError, TimeoutError } from '../src/utils/errors'

function jsonResponse(body: any, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: {
      get: (name: string) => init.headers?.[name] ?? null,
    },
    json: vi.fn().mockResolvedValue(body),
  } as any
}

describe('HttpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).fetch = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not make a request until an endpoint is explicitly configured', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    const client = new HttpClient()

    await expect(client.get('/v1/test')).rejects.toThrow(
      'HttpClient: Endpoint is required before making a request'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('builds url with query and returns api data payload on success', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 0, msg: 'ok', data: { value: 1 } })
    )

    const client = new HttpClient({ endpoint: 'https://api.example.com' })
    const result = await client.get('/v1/test', { query: { a: 1, b: 'x' } })

    expect(result).toEqual({ value: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/test?a=1&b=x')
  })

  it('does not add identifying default headers', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))

    const client = new HttpClient({ endpoint: 'https://api.example.com' })
    await client.get('/v1/test')

    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers).toEqual({ 'Content-Type': 'application/json' })
    expect(headers).not.toHaveProperty('User-Agent')
    expect(headers).not.toHaveProperty('X-Client')
  })

  it('preserves explicitly configured headers, user agent, and api key', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))

    const client = new HttpClient({
      endpoint: 'https://api.example.com',
      userAgent: 'Explicit Agent/2.0',
      headers: { 'X-Caller': 'caller' },
      apiKey: 'secret',
    })
    await client.get('/v1/test')

    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      'User-Agent': 'Explicit Agent/2.0',
      'X-Caller': 'caller',
      Authorization: 'Bearer secret',
    })
  })

  it('preserves the setHeaders merge contract', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request: 1 }))
      .mockResolvedValueOnce(jsonResponse({ request: 2 }))

    const client = new HttpClient({
      endpoint: 'https://api.example.com',
      headers: { 'X-Caller': 'caller' },
      apiKey: 'secret',
    })
    client.setHeaders({ 'X-First': 'first' })
    await client.get('/v1/first')

    client.setHeaders({ 'X-Second': 'second' })
    await client.get('/v1/second')

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'X-First': 'first',
    })
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      'Content-Type': 'application/json',
      'X-Caller': 'caller',
      Authorization: 'Bearer secret',
      'X-First': 'first',
      'X-Second': 'second',
    })
  })

  it('lets per-request headers override configured and set headers', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))

    const client = new HttpClient({
      endpoint: 'https://api.example.com',
      headers: { 'X-Scope': 'configured' },
    })
    client.setHeaders({ 'X-Scope': 'runtime' })

    await client.get('/v1/test', { headers: { 'X-Scope': 'request' } })

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-Scope': 'request' })
  })

  it('removes configured and set headers', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))

    const client = new HttpClient({
      endpoint: 'https://api.example.com',
      headers: { 'X-Configured': 'configured' },
    })
    client.setHeaders({ 'X-Runtime': 'runtime' })
    client.removeHeader('X-Configured')
    client.removeHeader('X-Runtime')

    await client.get('/v1/test')

    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
    })
  })

  it('throws ApiClientError when api code is non-zero', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 1001, msg: 'bad request', data: null })
    )

    const client = new HttpClient({ endpoint: 'https://api.example.com' })

    await expect(client.get('/v1/test')).rejects.toMatchObject<Partial<ApiClientError>>({
      name: 'ApiClientError',
      code: 1001,
      message: 'bad request',
    })
  })

  it('throws RateLimitError on 429 and parses Retry-After header', async () => {
    const fetchMock = vi.mocked(globalThis.fetch as any)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({}, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '12' } })
    )

    const client = new HttpClient({ endpoint: 'https://api.example.com' })

    await expect(client.get('/v1/test')).rejects.toMatchObject<Partial<RateLimitError>>({
      name: 'RateLimitError',
      retryAfter: 12,
    })
  })

  it('retries on retryable errors and succeeds on later attempt', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.mocked(globalThis.fetch as any)

    fetchMock
      .mockRejectedValueOnce(new Error('temporary network issue'))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'ok', data: { done: true } }))

    const client = new HttpClient({ endpoint: 'https://api.example.com', retries: 1 })

    const promise = client.get('/v1/retry')
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toEqual({ done: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('maps AbortError to TimeoutError', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.mocked(globalThis.fetch as any)
    const abortError = new Error('aborted') as any
    abortError.name = 'AbortError'
    fetchMock.mockRejectedValueOnce(abortError).mockRejectedValueOnce(abortError)

    const client = new HttpClient({ endpoint: 'https://api.example.com', timeout: 1234, retries: 1 })

    const rejection = expect(client.get('/v1/timeout')).rejects.toMatchObject<Partial<TimeoutError>>({
      name: 'TimeoutError',
      message: 'Request timeout after 1234ms',
    })
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
  })
})
