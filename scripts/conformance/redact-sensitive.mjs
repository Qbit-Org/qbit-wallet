const PRIVATE_EXTENDED_KEY = /(?:qprv|tqpv|qrpv|xprv|tprv)[1-9A-HJ-NP-Za-km-z]+/g

export function redactSensitive(value) {
  return String(value).replace(PRIVATE_EXTENDED_KEY, '<redacted-private-key>')
}
