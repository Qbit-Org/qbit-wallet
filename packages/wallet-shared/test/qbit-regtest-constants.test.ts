import { describe, expect, it } from 'vitest'

import { CHAINS_MAP } from '../src/constants/common'
import {
  QBIT_REGTEST_GENESIS_HASH,
  QBIT_REGTEST_HOST_PERMISSION,
  QBIT_REGTEST_IDENTITY_ROUTE,
  QBIT_REGTEST_ORIGIN,
  QBIT_REGTEST_TIP_HEIGHT_ROUTE,
  REGTEST_ACCESS_ACK_VERSION,
} from '../src/constants/qbit-regtest'
import { ErrorCodes, ErrorMessages } from '../src/errors'
import { ChainType } from '@qbit/wallet-types'

describe('qbit regtest access constants', () => {
  it('pins the loopback origin to the exact host and port the chain table uses', () => {
    expect(QBIT_REGTEST_ORIGIN).toBe('http://127.0.0.1:3002')
    expect(QBIT_REGTEST_HOST_PERMISSION).toBe('http://127.0.0.1:3002/*')
    expect(CHAINS_MAP[ChainType.QBIT_REGTEST]?.endpoints).toEqual([QBIT_REGTEST_ORIGIN])
    expect(CHAINS_MAP[ChainType.QBIT_REGTEST]?.websiteUrl).toBe(QBIT_REGTEST_ORIGIN)
    // Never a wildcard host, an unscoped loopback port, or a hostname.
    expect(QBIT_REGTEST_HOST_PERMISSION).not.toMatch(/localhost|\*\/|:\*|<all_urls>/)
  })

  it('records the reviewed regtest genesis identity and read-only probe routes', () => {
    expect(QBIT_REGTEST_GENESIS_HASH).toMatch(/^[0-9a-f]{64}$/)
    // A different chain family's regtest genesis must not satisfy the identity check.
    expect(QBIT_REGTEST_GENESIS_HASH).not.toBe(
      '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
    )
    expect(QBIT_REGTEST_IDENTITY_ROUTE).toBe('/block-height/0')
    expect(QBIT_REGTEST_TIP_HEIGHT_ROUTE).toBe('/blocks/tip/height')
    expect(REGTEST_ACCESS_ACK_VERSION).toBe('regtest_access_ack_v1')
  })

  it('maps the regtest capability failures to stable user-safe message keys', () => {
    expect(ErrorMessages[ErrorCodes.REGTEST_ACCESS_LOCKED]).toBe('regtest_access_not_enabled')
    expect(ErrorMessages[ErrorCodes.REGTEST_SERVICE_UNREACHABLE]).toBe(
      'regtest_service_unavailable'
    )
    expect(ErrorMessages[ErrorCodes.REGTEST_SERVICE_UNEXPECTED]).toBe('regtest_service_unexpected')
  })
})
