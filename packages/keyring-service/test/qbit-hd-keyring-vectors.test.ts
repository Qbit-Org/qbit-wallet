import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { init } from '@qbit-oss/pqc'
import { QbitHdKeyring } from '../src/keyrings/qbit-hd-keyring'

// Mnemonic-to-address vectors through QbitHdKeyring, written by
// scripts/conformance/generate-keyring-vectors.mjs with the SDK named in
// `generatedWith`. An SDK update must pass them unchanged: a different pubkey
// or address means the wallet would derive other keys from the same seed.
// Regenerating them changes `generatedWith`, which this test pins, so that
// can only land as a reviewed change here.

interface KeyringVectorAccount {
  index: number
  path: string
  pubkey: string
  scriptPubKey: string
  addresses: Record<string, string>
}

interface KeyringVectorCase {
  mnemonic: string
  passphrase: string
  hdPath: string
  accounts: KeyringVectorAccount[]
}

const vectors: {
  generatedWith: Record<string, string>
  networks: string[]
  indexes: number[]
  cases: KeyringVectorCase[]
} = JSON.parse(readFileSync(join(__dirname, 'fixtures/qbit-hd-keyring-vectors.json'), 'utf8'))

// The BIP39 reference vectors for entropy 00..00, 7f..7f, 80..80 and ff..ff.
const MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote',
]
const HD_PATHS = ["m/87'/0'/0'/0", "m/87'/0'/0'/1", "m/87'/1'/0'/0", "m/87'/1'/0'/1"]

describe('qbit-hd-keyring derivation vectors', () => {
  beforeAll(async () => {
    await init()
  })

  it('were generated with @qbit-oss 0.1.0 and never since', () => {
    expect(vectors.generatedWith).toEqual({
      '@qbit-oss/pqc':
        '0.1.0 sha512-NZAWoRggBtQHdCyXFfA4odcgnxedrwV57nZMHkhutS/UnPpzNBGwVPUMQcmIfxlF9IPU5Q0FRtJ5VnoQ59vqCA==',
      '@qbit-oss/protocol':
        '0.1.0 sha512-7GGEVWwmMgL5XL8FQlFJeXwUkW2y2ciLq6bv5VYz6Bp6cea64HNItg77XpKkupDfz/Hg5ghKaupez3Zp+08uJQ==',
    })
  })

  it('cover each mnemonic with and without a passphrase on every path, index and network', () => {
    expect(vectors.networks).toEqual(['mainnet', 'testnet4', 'signet', 'regtest'])
    expect(vectors.indexes).toEqual([0, 1, 19, 2 ** 31 - 2, 2 ** 31 - 1])
    expect(vectors.cases).toHaveLength(MNEMONICS.length * 2 * HD_PATHS.length)
    for (const mnemonic of MNEMONICS) {
      for (const withPassphrase of [false, true]) {
        const covered = vectors.cases.filter(
          vector => vector.mnemonic === mnemonic && (vector.passphrase !== '') === withPassphrase
        )
        expect(covered.map(vector => vector.hdPath).sort()).toEqual(HD_PATHS)
      }
    }
    for (const vector of vectors.cases) {
      expect(vector.accounts.map(account => account.index)).toEqual(vectors.indexes)
      for (const account of vector.accounts) {
        expect(Object.keys(account.addresses)).toEqual(vectors.networks)
      }
    }
  })

  vectors.cases.forEach((vector, caseIndex) => {
    const words = vector.mnemonic.split(' ').length
    const passphrase = vector.passphrase ? 'with' : 'without'
    it(`case ${caseIndex}: ${words}-word mnemonic ${passphrase} a passphrase at ${vector.hdPath}`, async () => {
      const keyring = new QbitHdKeyring({
        mnemonic: vector.mnemonic,
        passphrase: vector.passphrase,
        hdPath: vector.hdPath,
        activeIndexes: vectors.indexes,
      })
      const accounts = await keyring.getQbitAccounts()
      expect(
        accounts.map(account => ({
          index: account.index,
          path: account.path,
          pubkey: account.pubkey,
          scriptPubKey: account.scriptPubKey,
          addresses: account.addresses,
        }))
      ).toEqual(vector.accounts)
    })
  })
})
