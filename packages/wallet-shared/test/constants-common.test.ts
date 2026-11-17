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
  RETIRED_AUTO_LOCK_TIME_IDS,
  SHORTEST_LOCKTIME_ID,
  SUPPORTED_LOCALES,
  getAutoLockTimes,
  getLockTimeInfo,
  isAutoLockTimeId,
  repairStoredAutoLockTimeId,
  resolveAutoLockTimeId,
  getQbitHdPathForChainType,
  normalizeAvailableChainType,
  normalizeChainType,
} from '../src/constants/common'
import { PlatformEnv } from '../src/constants/platform'
import { ChainType, NetworkType } from '@qbit/wallet-types'

const UNKNOWN_CHAIN = 'NOT_A_CHAIN'
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

describe('common constants', () => {
  it('getAutoLockTimes offers six times, shortest first, with the count substituted', () => {
    const t = (key: string, count?: string) => `${key}:${count}`

    expect(getAutoLockTimes(t)).toEqual([
      { id: 3, time: 5 * MINUTE_MS, label: 'n_minutes:5' },
      { id: 8, time: 15 * MINUTE_MS, label: 'n_minutes:15' },
      { id: 5, time: 30 * MINUTE_MS, label: 'n_minutes:30' },
      { id: 6, time: 60 * MINUTE_MS, label: 'n_hour:1' },
      { id: 9, time: 3 * HOUR_MS, label: 'n_hours:3' },
      { id: 10, time: 6 * HOUR_MS, label: 'n_hours_many:6' },
    ])
  })

  it('defaults to 30 minutes, and its shortest time is 5 minutes', () => {
    const times = getAutoLockTimes((key: string) => key)
    expect(times.find(v => v.id === DEFAULT_LOCKTIME_ID)?.time).toBe(30 * MINUTE_MS)
    expect(SHORTEST_LOCKTIME_ID).toBe(3)
    expect(Math.min(...times.map(v => v.time))).toBe(
      times.find(v => v.id === SHORTEST_LOCKTIME_ID)?.time
    )
  })

  it('never gives a retired id a new meaning', () => {
    expect([...RETIRED_AUTO_LOCK_TIME_IDS.keys()]).toEqual([0, 1, 2, 4, 7])
    for (const [retired, replacement] of RETIRED_AUTO_LOCK_TIME_IDS) {
      expect(isAutoLockTimeId(retired)).toBe(false)
      expect(isAutoLockTimeId(replacement)).toBe(true)
    }
  })

  // What each time stored up to 1.0.9 (ids 0 to 7) becomes.
  it.each([
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [4, 8],
    [5, 5],
    [6, 6],
    [7, 9],
  ])('resolveAutoLockTimeId reads the stored id %s as %s', (stored, current) => {
    expect(resolveAutoLockTimeId(stored)).toBe(current)
  })

  it.each([8, 9, 10])('resolveAutoLockTimeId keeps the current id %s', id => {
    expect(resolveAutoLockTimeId(id)).toBe(id)
  })

  it('resolveAutoLockTimeId reads nothing stored as the default', () => {
    expect(resolveAutoLockTimeId(undefined)).toBe(DEFAULT_LOCKTIME_ID)
  })

  it.each([
    ['an id unknown to this build', 11],
    ['a negative id', -1],
    ['a fractional id', 2.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['null', null],
    ['a string', '5'],
    ['an object', { id: 5 }],
    ['a boolean', true],
  ])('resolveAutoLockTimeId reads %s as the shortest time', (_name, stored) => {
    expect(resolveAutoLockTimeId(stored)).toBe(SHORTEST_LOCKTIME_ID)
  })

  // What start-up stores again for each time stored up to 1.0.9.
  it.each([
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [4, 8],
    [5, 5],
    [6, 6],
    [7, 9],
  ])('repairStoredAutoLockTimeId stores the stored id %s as %s', (stored, repaired) => {
    expect(repairStoredAutoLockTimeId(stored)).toBe(repaired)
  })

  it.each([8, 9, 10])('repairStoredAutoLockTimeId keeps the current id %s', id => {
    expect(repairStoredAutoLockTimeId(id)).toBe(id)
  })

  it.each([11, 12, 255, 1_000])(
    'repairStoredAutoLockTimeId keeps %s, an id a later build may have stored',
    id => {
      expect(repairStoredAutoLockTimeId(id)).toBe(id)
      expect(resolveAutoLockTimeId(id)).toBe(SHORTEST_LOCKTIME_ID)
    }
  )

  it('repairStoredAutoLockTimeId leaves nothing stored as it is', () => {
    expect(repairStoredAutoLockTimeId(undefined)).toBeUndefined()
  })

  it.each([
    ['null', null],
    ['a string', '5'],
    ['a fractional number', 2.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a number past the safe integers', 2 ** 53],
    ['a negative whole number', -1],
    ['another negative whole number', -7],
    ['an object', { id: 5 }],
    ['a boolean', true],
  ])('repairStoredAutoLockTimeId stores %s as the shortest time', (_name, stored) => {
    expect(repairStoredAutoLockTimeId(stored)).toBe(SHORTEST_LOCKTIME_ID)
  })

  it('repairStoredAutoLockTimeId never changes the time a stored value reads as', () => {
    const values = [undefined, null, '5', 2.5, NaN, Infinity, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    for (const stored of [...values, 11, 1_000]) {
      expect(resolveAutoLockTimeId(repairStoredAutoLockTimeId(stored))).toBe(
        resolveAutoLockTimeId(stored)
      )
    }
  })

  it('isAutoLockTimeId accepts only the ids offered now', () => {
    for (const { id } of getAutoLockTimes((key: string) => key)) {
      expect(isAutoLockTimeId(id)).toBe(true)
    }
    for (const value of [0, 1, 2, 4, 7, 11, -1, 2.5, NaN, null, undefined, '5']) {
      expect(isAutoLockTimeId(value)).toBe(false)
    }
  })

  it('getLockTimeInfo returns the entry for a current id, with its label', () => {
    expect(getLockTimeInfo(8, (key: string, count?: string) => `${key}:${count}`)).toEqual({
      id: 8,
      time: 15 * MINUTE_MS,
      label: 'n_minutes:15',
    })
  })

  it('getLockTimeInfo reads a retired id as its replacement, never as the default', () => {
    expect(getLockTimeInfo(2).id).toBe(3)
    expect(getLockTimeInfo(4).id).toBe(8)
    expect(getLockTimeInfo(7).id).toBe(9)
  })

  it('getLockTimeInfo reads an unknown id as the shortest time and nothing as the default', () => {
    expect(getLockTimeInfo(999).id).toBe(SHORTEST_LOCKTIME_ID)
    expect(getLockTimeInfo(null).id).toBe(SHORTEST_LOCKTIME_ID)
    expect(getLockTimeInfo(undefined).id).toBe(DEFAULT_LOCKTIME_ID)
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
    expect(normalizeChainType('')).toBe(ChainType.QBIT_MAINNET)
  })

  // A stored or requested chain that names a property every object inherits
  // is not a chain: the wallet treats every chain it normalizes as a Qbit one.
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'falls back to Qbit Mainnet for the inherited key %s',
    key => {
      expect(normalizeChainType(key)).toBe(ChainType.QBIT_MAINNET)
      expect(normalizeAvailableChainType(key)).toBe(ChainType.QBIT_MAINNET)
    }
  )

  // Stored data can hold any value. One that converts to a chain name, such as
  // an array or a String object, is still not a chain: both return the
  // primitive Mainnet string, never the value itself.
  it.each<[string, unknown]>([
    ["['QBIT_MAINNET']", ['QBIT_MAINNET']],
    ["['QBIT_TESTNET4']", ['QBIT_TESTNET4']],
    ["['QBIT_REGTEST']", ['QBIT_REGTEST']],
    ["new String('QBIT_TESTNET4')", new String('QBIT_TESTNET4')],
    ["{ toString: () => 'QBIT_MAINNET' }", { toString: () => 'QBIT_MAINNET' }],
    ['null', null],
    ['123', 123],
  ])('falls back to Qbit Mainnet for the non-string value %s', (_label, value) => {
    expect(normalizeChainType(value as string)).toBe(ChainType.QBIT_MAINNET)
    expect(normalizeAvailableChainType(value as string)).toBe(ChainType.QBIT_MAINNET)
  })

  it.each(Object.values(ChainType))('keeps the chain %s', chainType => {
    expect(normalizeChainType(chainType)).toBe(chainType)
    expect(normalizeAvailableChainType(chainType)).toBe(chainType)
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
      expect(normalizeAvailableChainType('')).toBe(ChainType.QBIT_MAINNET)
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
