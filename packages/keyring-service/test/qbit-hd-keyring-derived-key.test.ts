import { beforeAll, describe, expect, it, vi } from 'vitest'

import { init, type PqcDerivedKey } from '@qbit-oss/pqc'
import { QbitHdKeyring } from '../src/keyrings/qbit-hd-keyring'

// @qbit-oss/pqc 0.1.1 also exposes a derived key as `publicKey` and
// `secretKey`: non-enumerable getters for the same arrays as `pk32` and
// `sk64`. The keyring zeroes `pk32` and `sk64` once it is done with a key, so
// that only holds if the aliases are those arrays and never copies.

const derived = vi.hoisted(() => [] as unknown[])

vi.mock('@qbit-oss/pqc', async importOriginal => {
  const pqc = await importOriginal<typeof import('@qbit-oss/pqc')>()
  return {
    ...pqc,
    derivePQCKey: vi.fn((...args: Parameters<typeof pqc.derivePQCKey>) => {
      const key = pqc.derivePQCKey(...args)
      derived.push(key)
      return key
    }),
  }
})

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

type DerivedKeyPair = PqcDerivedKey & { publicKey?: Uint8Array; secretKey?: Uint8Array }

function expectZeroed(key: DerivedKeyPair) {
  expect(key.secretKey).toBe(key.sk64)
  expect(key.publicKey).toBe(key.pk32)
  expect(key.sk64.every(byte => byte === 0)).toBe(true)
  expect(key.pk32.every(byte => byte === 0)).toBe(true)
  // Enumeration and serialization see only the zeroed arrays.
  expect(Object.keys(key).sort()).toEqual(['pk32', 'sk64'])
  expect(JSON.stringify(key)).not.toMatch(/publicKey|secretKey/)
}

describe('qbit-hd-keyring derived PQC keys', () => {
  beforeAll(async () => {
    await init()
  })

  it('zeroes every derived key, through both names, after deriving, signing and exporting', async () => {
    const keyring = new QbitHdKeyring({
      mnemonic: MNEMONIC,
      hdPath: "m/87'/1'/0'/0",
      activeIndexes: [0],
    })
    const [account] = await keyring.getQbitAccounts()
    await keyring.signPqcDigest(account!.pubkey, new Uint8Array(32).fill(1))
    const exported = await keyring.exportAccount(account!.pubkey)

    expect(exported).toMatch(/^[0-9a-f]{128}$/)
    expect(derived).toHaveLength(3)
    for (const key of derived) expectZeroed(key as DerivedKeyPair)
  })
})
