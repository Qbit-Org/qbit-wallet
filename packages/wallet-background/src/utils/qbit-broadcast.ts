import { QbitApiError } from '@qbit-oss/api'
import {
  qbitBroadcastErrorMessage,
  sanitizeQbitBroadcastDetail,
  type QbitBroadcastFailureReason,
} from '@qbit/wallet-shared'

/**
 * A definitive node rejection is only reported as `not_sent` after this many
 * consecutive lifecycle probes all miss the transaction, because the indexer
 * can lag the node right after a broadcast.
 */
export const QBIT_BROADCAST_ABSENCE_PROBES = 3
/** Pause between those probes. */
export const QBIT_BROADCAST_ABSENCE_PROBE_DELAY_MS = 2_000

export function qbitBroadcastProbeDelay(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * Pause before each re-send of the same signed bytes after a broadcast whose
 * outcome stayed unknown and whose lookup then missed the transaction (see
 * `isQbitBroadcastResendable`). One entry per re-send, so its length bounds
 * them.
 */
export const QBIT_BROADCAST_RESEND_DELAYS_MS: readonly number[] = [1_000, 3_000]
/**
 * No re-send starts once this long has passed since the first dispatch, so a
 * backend that keeps timing out holds the send screen for at most one more
 * request (and its lookup) past it.
 */
export const QBIT_BROADCAST_RESEND_WINDOW_MS = 30_000

/**
 * Thrown from inside the guarded broadcast callback when a 2xx answer does
 * not echo the expected txid (a proxy page, an unexpected backend). It
 * carries no response text, so the body never reaches a result, and
 * rejecting from inside the guard keeps the send claim reserved for a
 * byte-identical retry instead of consuming it on a response nobody trusts.
 */
export class QbitBroadcastResponseMismatchError extends Error {
  constructor() {
    super('broadcast response did not echo the expected transaction id')
    this.name = 'QbitBroadcastResponseMismatchError'
  }
}

export interface QbitBroadcastErrorClassification {
  reason: QbitBroadcastFailureReason
  /**
   * True only when the node itself answered that it will not accept these
   * bytes. Everything else (transport loss, timeouts, gateway errors, odd
   * responses) may hide an accepted transaction and stays inconclusive.
   */
  definitiveRejection: boolean
  detail?: string
}

// mempool-qbit reserves this generic body for failures without an RPC error
// code (for example the backend could not reach its node), so it proves
// nothing about whether the node saw the transaction.
const GENERIC_BROADCAST_FAILURE =
  /^(?:(?:failed|unable) to|could not) (?:send|submit|broadcast)(?: raw)? transaction$/
// "txn-already-in-mempool", "txn-already-known", "Transaction already in
// block chain": the node has the transaction, so this is acceptance, not a
// rejection, and the lifecycle lookup decides.
const ALREADY_ACCEPTED_REASON =
  /txn-already-in-mempool|txn-already-known|already (?:in|known)\b|already in (?:the )?(?:block ?chain|mempool)/i
// Any mention of "already" is enough to withhold a definitive verdict, even
// when the exact phrase is not one of the known acceptance answers.
const ALREADY_ACCEPTED_HINT = /already/i

/**
 * qbitd JSON-RPC codes that only the node's transaction validation emits:
 * RPC_VERIFY_ERROR (-25, missing or spent inputs) and RPC_VERIFY_REJECTED
 * (-26, consensus or policy rejection). RPC_VERIFY_ALREADY_IN_CHAIN (-27) is
 * acceptance, and every other code (-1 misc, -28 warming up, JSON-RPC
 * protocol errors) says nothing about whether the node kept the bytes.
 */
const REJECTION_RPC_CODES = new Set([-25, -26])
const ALREADY_IN_CHAIN_RPC_CODE = -27

/**
 * Reject reasons the node's validation and policy layers report (qbitd's
 * validation.cpp and policy.cpp). Multi-word or hyphenated reasons are
 * distinctive enough to match anywhere in the message.
 */
const NODE_REJECT_REASON = new RegExp(
  `(?:^|[^a-z0-9-])(?:${[
    'bad-txns-[a-z0-9-]+',
    'txn-mempool-conflict',
    'txn-same-nonfinal-conflict',
    'mempool min fee not met',
    'min relay fee not met',
    'insufficient fee',
    'too-long-mempool-chain',
    'mandatory-script-verify-flag-failed',
    'non-mandatory-script-verify-flag',
    'bip125-replacement-disallowed',
    'replacement-adds-unconfirmed',
    'too many potential replacements',
    'missing-inputs',
    'missing inputs',
    'tx decode failed',
    'absurdly-high-fee',
    'max-fee-exceeded',
    'non-bip68-final',
    'scriptsig-size',
    'scriptsig-not-pushonly',
    'tx-size-small',
    'tx-size',
    'multi-op-return',
    'bare-multisig',
    'mempool full',
  ].join('|')})(?:$|[^a-z0-9-])`,
  'i'
)
// Single-word reasons are only trusted when they are the entire message.
const NODE_REJECT_WORD =
  /^(?:dust|version|coinbase|non-final|scriptpubkey|nonstandard|non-standard)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeRejectReason(message: string): boolean {
  return NODE_REJECT_REASON.test(message) || NODE_REJECT_WORD.test(message)
}

export interface QbitBroadcastRejection {
  /** Human-readable reason, empty when the body carried none. */
  message: string
  /** qbitd JSON-RPC error code when the body carried a node RPC envelope. */
  code?: number
}

const RPC_CODE_PATTERN = /"code"\s*:\s*(-\d+)\b/
const RPC_MESSAGE_PATTERN = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/

function rpcCode(value: unknown): number | undefined {
  // qbitd only emits negative codes; a proxy that answers with JSON uses
  // HTTP-style positive ones, which must never pass for a node envelope.
  return typeof value === 'number' && Number.isInteger(value) && value < 0 ? value : undefined
}

/**
 * Best-effort extraction of the node's answer from a broadcast error body.
 * Understands the plain esplora wrapper
 * (`sendrawtransaction RPC error: {"code":-26,"message":"..."}`) and the
 * mempool-qbit JSON shapes (`"reason"`, `{"error":"reason"}`,
 * `{"error":{"code":-27,"message":"..."}}`, `{"message":"reason"}`).
 */
export function qbitBroadcastRejection(body: string): QbitBroadcastRejection {
  let message = body
  let code: number | undefined
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed === 'string') message = parsed
    else if (isRecord(parsed)) {
      const parsedError = parsed['error']
      if (typeof parsedError === 'string') message = parsedError
      else if (isRecord(parsedError)) {
        message = typeof parsedError['message'] === 'string' ? parsedError['message'] : ''
        code = rpcCode(parsedError['code'])
      } else if (typeof parsed['message'] === 'string') {
        message = parsed['message']
        code = rpcCode(parsed['code'])
      }
    }
  } catch {
    // Plain-text esplora bodies are expected here.
  }
  const embeddedCode = RPC_CODE_PATTERN.exec(message)
  if (embeddedCode) {
    code = rpcCode(Number(embeddedCode[1])) ?? code
    const embeddedMessage = RPC_MESSAGE_PATTERN.exec(message)
    message = embeddedMessage?.[1] ? embeddedMessage[1].replace(/\\(.)/g, '$1') : ''
  }
  message = message.trim()
  return code === undefined ? { message } : { message, code }
}

/** Best-effort extraction of the human-readable rejection reason from a broadcast error body. */
export function qbitBroadcastRejectionDetail(body: string): string {
  return qbitBroadcastRejection(body).message
}

function normalizedBroadcastDetail(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function withDetail(
  reason: QbitBroadcastFailureReason,
  definitiveRejection: boolean,
  detail: string | undefined
): QbitBroadcastErrorClassification {
  return detail === undefined
    ? { reason, definitiveRejection }
    : { reason, definitiveRejection, detail }
}

/**
 * An HTTP 400 is only the node's verdict when its body is recognizably the
 * node's answer: an RPC error envelope, a known validation reject reason,
 * or one of the known acceptance/generic phrases. Anything else (a proxy or
 * gateway page, an HTML error, an empty or arbitrary body) is inconclusive,
 * and its text never surfaces, not even as collapsed support detail.
 */
function classifyHttpRejection(error: QbitApiError): QbitBroadcastErrorClassification {
  const body = error.responseBody?.trim() ?? ''
  const rejection = body ? qbitBroadcastRejection(body) : { message: '' }
  const { message, code } = rejection
  const nodeEnvelope = code !== undefined
  const knownReason = isNodeRejectReason(message)
  const alreadyAccepted =
    code === ALREADY_IN_CHAIN_RPC_CODE || ALREADY_ACCEPTED_REASON.test(message)
  const genericFailure = GENERIC_BROADCAST_FAILURE.test(normalizedBroadcastDetail(message))

  if (!nodeEnvelope && !knownReason && !alreadyAccepted && !genericFailure) {
    return withDetail('server', false, `HTTP ${error.status}`)
  }

  const detail = sanitizeQbitBroadcastDetail(
    `HTTP ${error.status}: ${message || `RPC error ${code}`}`
  )
  if (genericFailure && !knownReason) return withDetail('server', false, detail)

  const definitiveRejection =
    !alreadyAccepted &&
    !ALREADY_ACCEPTED_HINT.test(message) &&
    ((code !== undefined && REJECTION_RPC_CODES.has(code)) || knownReason)
  return withDetail('rejected', definitiveRejection, detail)
}

/**
 * `broadcastTx` never re-sends a submission that may have reached the node:
 * a timeout, a possibly-sent network error, a 5xx without the node's verdict
 * or a 2xx that is not a txid rejects as `unknown_outcome`. Its `cause` or
 * `status` names the failure that hid the verdict; the reply text never
 * surfaces.
 */
function classifyUnknownOutcome(error: QbitApiError): QbitBroadcastErrorClassification {
  const { cause, status } = error
  if (QbitApiError.is(cause) && (cause.kind === 'network' || cause.kind === 'timeout')) {
    return withDetail(cause.kind, false, sanitizeQbitBroadcastDetail(cause.message))
  }
  const statusLabel = status === undefined ? error.kind : `${error.kind} HTTP ${status}`
  if (status !== undefined && status >= 200 && status < 300) {
    return withDetail('invalid_response', false, sanitizeQbitBroadcastDetail(statusLabel))
  }
  return withDetail('server', false, sanitizeQbitBroadcastDetail(statusLabel))
}

/**
 * Classify an error raised after the broadcast request was dispatched. Only a
 * node-level HTTP 400 rejection with a recognizable reason is definitive; the
 * caller still has to prove absence with a lifecycle lookup before reporting
 * `not_sent`.
 */
export function classifyQbitBroadcastError(error: unknown): QbitBroadcastErrorClassification {
  if (error instanceof QbitBroadcastResponseMismatchError) {
    return withDetail('invalid_response', false, error.message)
  }
  if (error instanceof QbitApiError) {
    const statusLabel =
      error.status === undefined ? error.kind : `${error.kind} HTTP ${error.status}`
    switch (error.kind) {
      case 'network':
        return withDetail('network', false, sanitizeQbitBroadcastDetail(error.message))
      case 'timeout':
        return withDetail('timeout', false, sanitizeQbitBroadcastDetail(error.message))
      case 'parse':
        return withDetail('invalid_response', false, sanitizeQbitBroadcastDetail(error.message))
      case 'http':
        if (error.status === 400) return classifyHttpRejection(error)
        return withDetail('server', false, sanitizeQbitBroadcastDetail(statusLabel))
      case 'unknown_outcome':
        return classifyUnknownOutcome(error)
      case 'rate_limit':
      case 'payload_too_large':
      case 'not_found':
        return withDetail('server', false, sanitizeQbitBroadcastDetail(statusLabel))
      default:
        return withDetail('unexpected', false, sanitizeQbitBroadcastDetail(statusLabel))
    }
  }
  return withDetail(
    'unexpected',
    false,
    sanitizeQbitBroadcastDetail(qbitBroadcastErrorMessage(error))
  )
}

// The causes of an `unknown_outcome` that a re-send may get past.
const RESENDABLE_CAUSES: ReadonlySet<string> = new Set(['timeout', 'network', 'parse'])

/**
 * True when a dispatched broadcast failed in a way that sending the same
 * bytes again may get past, and that says nothing about whether the node
 * kept them: `broadcastTx`'s `unknown_outcome` (a timeout or connection lost
 * after sending, a 5xx without the node's verdict, a 2xx that is not the
 * txid, the backend losing its node), a 2xx that echoes another txid, and a
 * connection that provably never opened. A re-send is harmless when the
 * node already holds the transaction: it answers with the txid or as
 * already known (-27), which `broadcastTx` resolves as success.
 *
 * Nothing else qualifies: a node verdict as the client reports it (`http`,
 * whatever the status, and definitive or not), a 429 the client already
 * waited out or was told to wait longer for, a missing route, a refused
 * redirect (the next would be refused too), a cancelled call and any other
 * throw. The caller must still look the transaction up first, and re-send
 * only once the lookup misses it; and once an outcome is unknown, a
 * re-send's rejection must not turn it into "not sent".
 */
export function isQbitBroadcastResendable(error: unknown): boolean {
  if (error instanceof QbitBroadcastResponseMismatchError) return true
  if (!(error instanceof QbitApiError)) return false
  if (error.kind === 'network') return true
  if (error.kind !== 'unknown_outcome') return false
  // What hid the verdict: the reply alone (no cause), or the transport
  // timing out, failing or cutting the reply short. A refused redirect
  // (caused by `http`), a cancelled call (`aborted`) and any cause not
  // listed here are left alone.
  const { cause } = error
  return cause === undefined || (QbitApiError.is(cause) && RESENDABLE_CAUSES.has(cause.kind))
}

// The node's reason for a transaction over the standard weight, with the
// optional "<code>: " prefix and trailing detail older node versions add.
const TX_SIZE_REJECT_REASON = /^(?:\d+:\s*)?tx-size(?:$|[^a-z0-9-])/i

/**
 * True when the node definitively refused the bytes as larger than the
 * standard weight. That verdict depends on the bytes alone, so no retry of
 * them can succeed on any node running standard policy.
 */
export function isQbitTxSizeBroadcastRejection(error: unknown): boolean {
  if (!(error instanceof QbitApiError) || error.kind !== 'http' || error.status !== 400) {
    return false
  }
  if (!classifyQbitBroadcastError(error).definitiveRejection) return false
  return TX_SIZE_REJECT_REASON.test(qbitBroadcastRejection(error.responseBody ?? '').message)
}
