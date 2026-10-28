import { describe, expect, it } from 'vitest'

import { CHAINS_MAP } from '../src/constants/common'
import { getExplorerBaseUrl, getExplorerUrl } from '../src/utils/explorer'
import type { TypeChain } from '../src/constants/common'
import { ChainType } from '@qbit/wallet-types'

type ExplorerChainConfig = Pick<TypeChain, 'mempoolSpaceUrl'>

const mempoolChain = (mempoolSpaceUrl: string): ExplorerChainConfig => ({
  mempoolSpaceUrl,
})

describe('explorer URLs', () => {
  it('uses the configured explorer for Qbit mainnet and Testnet4', () => {
    const txid = 'ab'.repeat(32)

    expect(getExplorerUrl(CHAINS_MAP[ChainType.QBIT_TESTNET4], 'tx', txid)).toBe(
      `https://mempool-testnet.qbit.org/tx/${txid}`
    )
    expect(getExplorerUrl(CHAINS_MAP[ChainType.QBIT_MAINNET], 'tx', txid)).toBe(
      `https://mempool.qbit.org/tx/${txid}`
    )
    expect(getExplorerBaseUrl(CHAINS_MAP[ChainType.QBIT_REGTEST])).toBeUndefined()
  })

  it('preserves path prefixes and encodes identifiers as one path segment', () => {
    const chain = mempoolChain('https://example.com/explorer///')

    expect(getExplorerUrl(chain, 'address', 'qbit/../?query#fragment%')).toBe(
      'https://example.com/explorer/address/qbit%2F..%2F%3Fquery%23fragment%25'
    )
  })

  it('accepts absolute http localhost explorers', () => {
    const chain = mempoolChain('http://127.0.0.1:3000/ui/')

    expect(getExplorerUrl(chain, 'block', '0')).toBe('http://127.0.0.1:3000/ui/block/0')
  })

  it.each([
    '',
    '   ',
    '/relative',
    '//example.com',
    'javascript:alert(1)',
    'data:text/plain,nope',
    'file:///tmp/explorer',
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com?network=qbit',
    'https://example.com#qbit',
    'https://example.com:bad-port',
  ])('rejects an unsafe or malformed explorer base: %s', baseUrl => {
    expect(getExplorerBaseUrl(mempoolChain(baseUrl))).toBeUndefined()
  })

  it.each(['', ' ', '\n\t'])('rejects an empty explorer identifier', identifier => {
    expect(getExplorerUrl(mempoolChain('https://example.com'), 'tx', identifier)).toBeUndefined()
  })

  it('rejects a missing explorer identifier', () => {
    expect(getExplorerUrl(mempoolChain('https://example.com'), 'tx', undefined)).toBeUndefined()
  })

  it.each(['.', '..', ' padded', 'padded ', 'line\nbreak', '\ud800'])(
    'rejects an unsafe explorer identifier: %s',
    identifier => {
      expect(getExplorerUrl(mempoolChain('https://example.com'), 'tx', identifier)).toBeUndefined()
    }
  )

  it('rejects a missing chain', () => {
    expect(getExplorerBaseUrl(undefined)).toBeUndefined()
    expect(getExplorerUrl(undefined, 'tx', 'abc')).toBeUndefined()
  })
})
