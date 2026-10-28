import { describe, expect, it } from 'vitest'

import {
  BROWSER_TO_APP_LOCALE_MAP,
  CHAIN_GROUPS,
  CHAINS,
  CHAINS_MAP,
  DEFAULT_I18N_CONFIG,
  DEFAULT_LOCKTIME_ID,
  FALLBACK_LOCALE,
  LOCALE_NAMES,
  NETWORK_TYPES,
  SUPPORTED_LOCALES,
  getAutoLockTimes,
  getLockTimeInfo,
  getQbitHdPathForChainType,
  normalizeAvailableChainType,
  normalizeChainType,
} from '../src/constants/common'
import { PlatformEnv } from '../src/constants/platform'
import { ChainType, NetworkType } from '@qbit/wallet-types'

const UNKNOWN_CHAIN = 'NOT_A_CHAIN'

describe('common constants', () => {
  it('getAutoLockTimes builds translated labels with the count substituted', () => {
    const t = (key: string, count?: string) => `${key}:${count}`
    const times = getAutoLockTimes(t)

    expect(times).toHaveLength(8)
    expect(times[0]).toEqual({ id: 0, time: 30000, label: 'n_seconds:30' })
    expect(times[6]).toEqual({ id: 6, time: 3600000, label: 'n_hour:1' })
  })

  it('getLockTimeInfo returns exact entry or default fallback', () => {
    const found = getLockTimeInfo(4)
    expect(found.id).toBe(4)
    expect(found.time).toBe(600000)

    const fallback = getLockTimeInfo(999)
    expect(fallback.id).toBe(DEFAULT_LOCKTIME_ID)
  })

  it('chain map and chain list are consistent', () => {
    expect(CHAINS_MAP[ChainType.QBIT_TESTNET4]?.unit).toBe('QBT')
    expect(CHAINS_MAP[ChainType.QBIT_TESTNET4]?.networkType).toBe(NetworkType.TESTNET)
    expect(CHAINS_MAP[ChainType.QBIT_TESTNET4]).toMatchObject({
      endpoints: ['https://mempool-testnet.qbit.org/api'],
      icon: 'qbitTestnet',
      iconLabel: 'Testnet4',
      mempoolSpaceUrl: 'https://mempool-testnet.qbit.org',
      qbitApiSurface: 'mempool-qbit',
      svg: 'qbit-testnet',
    })
    expect(CHAINS_MAP[ChainType.QBIT_REGTEST]?.networkType).toBe(NetworkType.REGTEST)
    expect(CHAINS_MAP[ChainType.QBIT_REGTEST]).toMatchObject({
      icon: 'qbitRegtest',
      iconLabel: 'Regtest',
      mempoolSpaceUrl: '',
      svg: 'qbit-signet',
    })
    expect(CHAINS_MAP[ChainType.QBIT_MAINNET]).toMatchObject({
      endpoints: ['https://mempool.qbit.org/api'],
      iconLabel: 'Mainnet',
      mainnetReady: true,
      mempoolSpaceUrl: 'https://mempool.qbit.org',
      qbitApiSurface: 'mempool-qbit',
    })
    expect(CHAINS_MAP[ChainType.QBIT_MAINNET]?.disable).not.toBe(true)

    expect(CHAINS.map(chain => chain.enum)).toEqual([
      ChainType.QBIT_MAINNET,
      ChainType.QBIT_TESTNET4,
      ChainType.QBIT_REGTEST,
    ])
    expect(CHAINS).toHaveLength(Object.keys(CHAINS_MAP).length)
    expect(CHAIN_GROUPS.map(group => group.chain?.enum)).toEqual([
      ChainType.QBIT_MAINNET,
      ChainType.QBIT_TESTNET4,
      ChainType.QBIT_REGTEST,
    ])
  })

  it('never channel-disables regtest in the static chain table', () => {
    // Regtest availability is an asynchronous background capability (optional
    // host permission + acknowledgement + service identity), so the static
    // table must not approximate it with a synchronous flag.
    const originalChannel = PlatformEnv.CHANNEL
    try {
      for (const channel of ['store', 'e2e', 'github', 'unknown']) {
        PlatformEnv.CHANNEL = channel
        expect(CHAINS_MAP[ChainType.QBIT_REGTEST]?.disable).toBeUndefined()
        expect(CHAINS_MAP[ChainType.QBIT_MAINNET]?.disable).toBeUndefined()
        expect(CHAINS_MAP[ChainType.QBIT_TESTNET4]?.disable).toBeUndefined()
      }
    } finally {
      PlatformEnv.CHANNEL = originalChannel
    }
  })

  it('falls back to Qbit Mainnet for unknown or missing chain values', () => {
    expect(normalizeChainType(UNKNOWN_CHAIN)).toBe(ChainType.QBIT_MAINNET)
    expect(normalizeChainType(undefined)).toBe(ChainType.QBIT_MAINNET)
  })

  it('normalizeAvailableChainType keeps regtest and only rewrites unknown chains', () => {
    const originalChannel = PlatformEnv.CHANNEL
    try {
      for (const channel of ['store', 'e2e', 'github', 'unknown']) {
        PlatformEnv.CHANNEL = channel
        expect(normalizeAvailableChainType(ChainType.QBIT_REGTEST)).toBe(ChainType.QBIT_REGTEST)
        expect(normalizeChainType(ChainType.QBIT_REGTEST)).toBe(ChainType.QBIT_REGTEST)
      }
      expect(normalizeAvailableChainType(UNKNOWN_CHAIN)).toBe(ChainType.QBIT_MAINNET)
      expect(normalizeAvailableChainType(undefined)).toBe(ChainType.QBIT_MAINNET)
    } finally {
      PlatformEnv.CHANNEL = originalChannel
    }
  })

  it('builds qbit HD paths with the Core descriptor coin type split', () => {
    expect(getQbitHdPathForChainType(ChainType.QBIT_MAINNET)).toBe("m/87'/0'/0'/0")
    expect(getQbitHdPathForChainType(ChainType.QBIT_TESTNET4)).toBe("m/87'/1'/0'/0")
    expect(getQbitHdPathForChainType(ChainType.QBIT_REGTEST, 1)).toBe("m/87'/1'/0'/1")
  })

  it('i18n locale constants are internally consistent', () => {
    expect(FALLBACK_LOCALE).toBe('en')
    expect(DEFAULT_I18N_CONFIG.fallbackLocale).toBe(FALLBACK_LOCALE)
    expect(DEFAULT_I18N_CONFIG.supportedLocales).toEqual(SUPPORTED_LOCALES)

    expect(BROWSER_TO_APP_LOCALE_MAP['zh-CN']).toBe('zh_TW')
    expect(SUPPORTED_LOCALES.includes('zh_TW')).toBe(true)
    expect(LOCALE_NAMES.zh_TW).toBe('中文(繁體)')
  })

  it('network type descriptors include expected aliases', () => {
    expect(NETWORK_TYPES[0]).toMatchObject({
      value: NetworkType.MAINNET,
      label: 'LIVENET',
      name: 'livenet',
    })
    expect(NETWORK_TYPES[0]?.validNames).toContain('mainnet')
    expect(NETWORK_TYPES[1]).toMatchObject({
      value: NetworkType.TESTNET,
      label: 'TESTNET4',
      name: 'testnet4',
    })
    expect(NETWORK_TYPES[1]?.validNames).toContain('testnet')
    expect(NETWORK_TYPES[2]).toMatchObject({
      value: NetworkType.REGTEST,
      label: 'REGTEST',
      name: 'regtest',
    })
  })
})
