#!/usr/bin/env node
// Writes packages/keyring-service/test/fixtures/qbit-hd-keyring-vectors.json,
// which packages/keyring-service/test/qbit-hd-keyring-vectors.test.ts checks
// under `pnpm test`. Each case runs a public BIP39 test mnemonic, with and
// without a passphrase, through QbitHdKeyring: the BIP39 seed, BIP32
// m/87'/{0,1}'/0'/{0,1}/index, then the PQC HKDF and SLH-DSA key generation,
// and records the pubkey, scriptPubKey and address on every network.
//
// The vectors pin what an SDK update must not change, so regenerate them only
// for a reviewed derivation change, never to make an update pass:
//
//   corepack pnpm --filter "@qbit/keyring-service..." build
//   node scripts/conformance/generate-keyring-vectors.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format, resolveConfig } from 'prettier'
import {
  checkSdkPackages,
  MATRIX_SDK_PACKAGES,
  sdkPackageIdentities,
} from '../security/check-sdk-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputPath = resolve(
  root,
  'packages/keyring-service/test/fixtures/qbit-hd-keyring-vectors.json'
)

// The BIP39 reference vectors for entropy 00..00, 7f..7f, 80..80 (128 bits)
// and ff..ff (256 bits). Public test phrases: never fund them.
const mnemonics = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote',
]
// Composed characters, so the vectors also pin BIP39's NFKD normalization.
const passphrases = ['', 'qbit keyring test vectors: Ünïcödé']
const hdPaths = ["m/87'/0'/0'/0", "m/87'/0'/0'/1", "m/87'/1'/0'/0", "m/87'/1'/0'/1"]
// The first indexes, 19 for the last of a 20-address gap-limit scan, and the
// top of the non-hardened range QbitHdKeyring accepts (2^31 - 1) and the index
// below it.
const indexes = [0, 1, 19, 2 ** 31 - 2, 2 ** 31 - 1]
const networks = ['mainnet', 'testnet4', 'signet', 'regtest']

// The copies keyring-service derives with, checked against the committed pins.
const sdkPackages = checkSdkPackages(root)
if (sdkPackages.errors.length > 0) {
  throw new Error(`SDK packages do not match their pins:\n- ${sdkPackages.errors.join('\n- ')}`)
}
const sdkRequire = createRequire(resolve(root, 'packages/keyring-service/package.json'))
const [pqc, keyringPackage] = await Promise.all([
  import(pathToFileURL(sdkRequire.resolve('@qbit-oss/pqc')).href),
  import(pathToFileURL(resolve(root, 'packages/keyring-service/lib/qbit-hd-keyring.mjs')).href),
])
await pqc.init({
  wasmBinary: readFileSync(sdkRequire.resolve('@qbit-oss/pqc/wasm/pqc.wasm')),
})

const cases = []
for (const mnemonic of mnemonics) {
  for (const passphrase of passphrases) {
    for (const hdPath of hdPaths) {
      const keyring = new keyringPackage.QbitHdKeyring({
        mnemonic,
        passphrase,
        hdPath,
        activeIndexes: indexes,
      })
      const accounts = await keyring.getQbitAccounts()
      cases.push({
        mnemonic,
        passphrase,
        hdPath,
        accounts: accounts.map(account => ({
          index: account.index,
          path: account.path,
          pubkey: account.pubkey,
          scriptPubKey: account.scriptPubKey,
          addresses: Object.fromEntries(
            networks.map(network => [network, account.addresses[network]])
          ),
        })),
      })
    }
  }
}

const fixture = {
  schemaVersion: 1,
  name: 'qbit-hd-keyring-vectors',
  generatedBy: 'scripts/conformance/generate-keyring-vectors.mjs',
  generatedWith: sdkPackageIdentities(sdkPackages.pins, MATRIX_SDK_PACKAGES),
  networks,
  indexes,
  cases,
}

const prettierConfig = (await resolveConfig(outputPath)) || {}
writeFileSync(
  outputPath,
  await format(JSON.stringify(fixture), { ...prettierConfig, filepath: outputPath, parser: 'json' })
)
console.log(`wrote ${cases.length} cases to ${outputPath}`)
