/** Longest sanitized technical detail the UI will show behind a disclosure. */
export const QBIT_BROADCAST_DETAIL_MAX_LENGTH = 160

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi
// Hostname/port fragments that survive without a scheme (e.g. "127.0.0.1:3002").
const HOST_PORT_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|\blocalhost(?::\d{1,5})?\b/gi
// Any hex blob at least txid-sized: signed transactions, PSBTs, push bodies.
// The optional 0x prefix is consumed with the payload: "x" and the first hex
// digit are both word characters, so a boundary-anchored digit run alone can
// never start inside "0x<hex>" and the whole blob would survive.
const LONG_HEX_PATTERN = /\b(?:0x)?[0-9a-f]{64,}\b/gi

/**
 * Reduce free-form error text to something safe for a collapsed support
 * disclosure: endpoint URLs, host:port fragments, and every txid-or-longer
 * hex blob are removed, whitespace is collapsed, and the result is capped.
 * Returns undefined when nothing meaningful survives.
 */
export function sanitizeQbitBroadcastDetail(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const cleaned = text
    .replace(URL_PATTERN, '[url]')
    .replace(HOST_PORT_PATTERN, '[host]')
    .replace(LONG_HEX_PATTERN, '[hex]')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || cleaned === '[object Object]') return undefined
  return cleaned.length > QBIT_BROADCAST_DETAIL_MAX_LENGTH
    ? `${cleaned.slice(0, QBIT_BROADCAST_DETAIL_MAX_LENGTH - 3)}...`
    : cleaned
}

/** Extract the message from a thrown value without trusting its shape. */
export function qbitBroadcastErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return undefined
}
