/**
 * Bounded, read-only identity check for the local Qbit regtest indexer.
 *
 * The probe is deliberately narrow: two hard-coded GET routes on the fixed
 * loopback origin, a short timeout, a small response-size cap, no redirects,
 * no credentials and no wallet data. It distinguishes "nothing is listening"
 * from "something answered that is not the Qbit regtest API" (wrong genesis,
 * redirect, non-text or oversized body). It is not authentication: a hostile
 * local process can still emulate these answers.
 */

import {
  QBIT_REGTEST_GENESIS_HASH,
  QBIT_REGTEST_IDENTITY_ROUTE,
  QBIT_REGTEST_ORIGIN,
  QBIT_REGTEST_TIP_HEIGHT_ROUTE,
  type RegtestAccessReason,
} from '@qbit/wallet-shared'

export type RegtestFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface RegtestServiceVerificationOptions {
  fetch?: RegtestFetch
  now?: () => number
  /** Per-request timeout; both routes together are bounded by twice this. */
  timeoutMs?: number
  /** Maximum accepted body size per route; the expected bodies are tiny. */
  maxBodyBytes?: number
}

export type RegtestServiceVerification =
  | { ok: true; tipHeight: number; verifiedAt: number }
  | { ok: false; state: 'unreachable' | 'unexpected_service'; reason: RegtestAccessReason }

type ProbeResult =
  | { ok: true; body: string }
  | { ok: false; state: 'unreachable' | 'unexpected_service'; reason: RegtestAccessReason }

export const REGTEST_PROBE_TIMEOUT_MS = 3000
export const REGTEST_PROBE_MAX_BODY_BYTES = 256

const HEX_256_BIT = /^[0-9a-f]{64}$/i
const CANONICAL_HEIGHT = /^(?:0|[1-9][0-9]{0,9})$/

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: unknown }).name === 'AbortError' ||
      (error as { name?: unknown }).name === 'TimeoutError')
  )
}

function isLoopbackOrigin(url: string): boolean {
  try {
    return new URL(url).origin === QBIT_REGTEST_ORIGIN
  } catch {
    return false
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<{ text: string } | { overflow: true }> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { overflow: true }
    }
  }

  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      return { overflow: true }
    }
    return { text }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { overflow: true }
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released by cancel().
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder('utf-8').decode(bytes) }
}

async function probe(
  fetchImpl: RegtestFetch,
  route: string,
  timeoutMs: number,
  maxBodyBytes: number
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(`${QBIT_REGTEST_ORIGIN}${route}`, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'text/plain' },
        signal: controller.signal,
      })
    } catch (error) {
      return {
        ok: false,
        state: 'unreachable',
        reason: isAbortError(error) ? 'timeout' : 'network_error',
      }
    }

    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400) ||
      (response.url !== '' && !isLoopbackOrigin(response.url))
    ) {
      return { ok: false, state: 'unexpected_service', reason: 'redirect' }
    }
    if (response.status !== 200) {
      // 404/5xx: the origin is up but not serving the route yet (indexer still
      // syncing) or failing; anything else is not the expected API.
      const transient = response.status === 404 || response.status >= 500
      return {
        ok: false,
        state: transient ? 'unreachable' : 'unexpected_service',
        reason: 'http_status',
      }
    }
    const contentType = (response.headers.get('content-type') ?? '').trim().toLowerCase()
    if (!contentType.startsWith('text/plain')) {
      return { ok: false, state: 'unexpected_service', reason: 'content_type' }
    }

    let read: { text: string } | { overflow: true }
    try {
      read = await readBoundedText(response, maxBodyBytes)
    } catch (error) {
      return {
        ok: false,
        state: 'unreachable',
        reason: isAbortError(error) ? 'timeout' : 'network_error',
      }
    }
    if ('overflow' in read) {
      return { ok: false, state: 'unexpected_service', reason: 'oversized' }
    }
    return { ok: true, body: read.text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Verify that the fixed loopback origin is the Qbit regtest Esplora API by
 * comparing its height-zero block hash with the reviewed genesis hash, then
 * confirm the tip-height route the wallet depends on answers sensibly.
 */
export async function verifyRegtestService(
  options: RegtestServiceVerificationOptions = {}
): Promise<RegtestServiceVerification> {
  const fetchImpl =
    options.fetch ??
    (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch.bind(globalThis) as RegtestFetch)
      : undefined)
  if (!fetchImpl) {
    return { ok: false, state: 'unreachable', reason: 'network_error' }
  }
  const timeoutMs = options.timeoutMs ?? REGTEST_PROBE_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? REGTEST_PROBE_MAX_BODY_BYTES
  const now = options.now ?? Date.now

  const identity = await probe(fetchImpl, QBIT_REGTEST_IDENTITY_ROUTE, timeoutMs, maxBodyBytes)
  if (!identity.ok) {
    return identity
  }
  const genesisHash = identity.body.trim()
  if (!HEX_256_BIT.test(genesisHash)) {
    return { ok: false, state: 'unexpected_service', reason: 'malformed' }
  }
  if (genesisHash.toLowerCase() !== QBIT_REGTEST_GENESIS_HASH) {
    return { ok: false, state: 'unexpected_service', reason: 'genesis_mismatch' }
  }

  const tip = await probe(fetchImpl, QBIT_REGTEST_TIP_HEIGHT_ROUTE, timeoutMs, maxBodyBytes)
  if (!tip.ok) {
    return tip.state === 'unreachable'
      ? tip
      : { ok: false, state: 'unexpected_service', reason: 'tip_unavailable' }
  }
  const height = tip.body.trim()
  if (!CANONICAL_HEIGHT.test(height)) {
    return { ok: false, state: 'unexpected_service', reason: 'tip_unavailable' }
  }

  return { ok: true, tipHeight: Number(height), verifiedAt: now() }
}
