import { describe, expect, it } from 'vitest'

import { sanitizeQbitBroadcastDetail } from '../src/utils/qbit-broadcast'

// Exactly txid-sized (64 hex characters) and a longer signed-transaction-sized blob.
const TXID_HEX = 'ab'.repeat(32)
const SIGNED_TX_HEX = '0f'.repeat(150)

describe('sanitizeQbitBroadcastDetail hex redaction', () => {
  it('redacts a 0x-prefixed txid-sized payload together with its prefix', () => {
    expect(sanitizeQbitBroadcastDetail(`rejected 0x${TXID_HEX}`)).toBe('rejected [hex]')
    expect(sanitizeQbitBroadcastDetail(`0x${TXID_HEX}`)).toBe('[hex]')
  })

  it('redacts an uppercase 0X prefix and uppercase hex digits', () => {
    expect(sanitizeQbitBroadcastDetail(`rejected 0X${TXID_HEX.toUpperCase()} by qbitd`)).toBe(
      'rejected [hex] by qbitd'
    )
    expect(sanitizeQbitBroadcastDetail(`0x${TXID_HEX.toUpperCase()}`)).toBe('[hex]')
  })

  it('redacts 0x-prefixed payloads longer than a txid', () => {
    const detail = sanitizeQbitBroadcastDetail(`push failed for 0x${SIGNED_TX_HEX}`)
    expect(detail).toBe('push failed for [hex]')
    expect(detail).not.toContain('0f0f')
  })

  it('redacts 0x-prefixed payloads against punctuation, quotes, and line breaks', () => {
    expect(sanitizeQbitBroadcastDetail(`tx=0x${TXID_HEX},status=rejected`)).toBe(
      'tx=[hex],status=rejected'
    )
    expect(sanitizeQbitBroadcastDetail(`{"hex":"0x${TXID_HEX}"}`)).toBe('{"hex":"[hex]"}')
    expect(sanitizeQbitBroadcastDetail(`(0x${TXID_HEX})`)).toBe('([hex])')
    expect(sanitizeQbitBroadcastDetail(`raw:0x${TXID_HEX}.`)).toBe('raw:[hex].')
    expect(sanitizeQbitBroadcastDetail(`body\n0x${TXID_HEX}\nend`)).toBe('body [hex] end')
  })

  it('redacts several 0x-prefixed payloads independently', () => {
    expect(sanitizeQbitBroadcastDetail(`0x${TXID_HEX} then 0x${'cd'.repeat(32)}`)).toBe(
      '[hex] then [hex]'
    )
  })

  it('keeps redacting ordinary unprefixed hex, including hex that starts with a zero', () => {
    expect(sanitizeQbitBroadcastDetail(`txid ${TXID_HEX} rejected`)).toBe('txid [hex] rejected')
    expect(sanitizeQbitBroadcastDetail(`0${TXID_HEX}`)).toBe('[hex]')
    expect(sanitizeQbitBroadcastDetail(`0a${TXID_HEX}`)).toBe('[hex]')
  })

  it('leaves 0x-prefixed hex shorter than a txid alone', () => {
    const short = `0x${'ab'.repeat(31)}` // 62 hex characters after the prefix
    expect(sanitizeQbitBroadcastDetail(`code ${short}`)).toBe(`code ${short}`)
    const almost = `0x${'a'.repeat(63)}` // 65 characters in total, only 63 of them hex
    expect(sanitizeQbitBroadcastDetail(almost)).toBe(almost)
  })

  it('does not swallow neighbouring non-hex words', () => {
    expect(sanitizeQbitBroadcastDetail(`fee 0x${TXID_HEX} ok`)).toBe('fee [hex] ok')
    expect(sanitizeQbitBroadcastDetail(`0x${TXID_HEX}-rejected`)).toBe('[hex]-rejected')
    expect(sanitizeQbitBroadcastDetail(`rejected-0x${TXID_HEX}`)).toBe('rejected-[hex]')
  })
})
