import assert from 'node:assert/strict'
import { createHash, hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The wallet's PQC vectors, run against the installed @qbit-oss/pqc that the
// keyring signs with: the SLH-DSA golden vectors this repository commits, and
// the qbit Core derivation and signature vectors the package ships (bound by
// the lockfile integrity that scripts/security/check-sdk-packages.mjs checks).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromKeyring = createRequire(join(repoRoot, 'packages/keyring-service/package.json'))
const packageRoot = dirname(requireFromKeyring.resolve('@qbit-oss/pqc/package.json'))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const golden = readJson(join(repoRoot, 'experiments/pqc-wasm/fixtures/slh-dsa-golden.json'))
const coreDerivation = readJson(join(packageRoot, 'fixtures/qbit-core-derivation.json'))
const coreSignatures = readJson(join(packageRoot, 'fixtures/qbit-core-signature-vectors.json'))

const fromHex = hex => Uint8Array.from(Buffer.from(hex, 'hex'))
const toHex = bytes => Buffer.from(bytes).toString('hex')
// Signatures are compared by digest so a mismatch never prints signature hex.
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex')

let pqc
before(async () => {
  pqc = await import(pathToFileURL(requireFromKeyring.resolve('@qbit-oss/pqc')).href)
  await pqc.init({ wasmBinary: readFileSync(join(packageRoot, 'wasm/pqc.wasm')) })
})

test('the committed golden fixture is the copy the package ships', () => {
  assert.equal(
    readFileSync(join(packageRoot, 'fixtures/slh-dsa-golden.json'), 'utf8'),
    readFileSync(join(repoRoot, 'experiments/pqc-wasm/fixtures/slh-dsa-golden.json'), 'utf8')
  )
  assert.equal(golden.algorithm, pqc.constants.ALGORITHM)
})

for (const vector of golden.vectors) {
  test(`SLH-DSA golden vector ${vector.name} keygen, sign and verify`, () => {
    // deterministic_entropy(seed): byte[i] = seed + ((i * 37) % 256) mod 256
    const entropy = Uint8Array.from(
      { length: pqc.constants.MIN_ENTROPY },
      (_, i) => (vector.seedByte + ((i * 37) % 256)) & 0xff
    )
    const pair = pqc.keygen(entropy)
    assert.equal(toHex(pair.publicKey), vector.publicKeyHex)
    assert.equal(toHex(pair.secretKey), vector.secretKeyHex)
    const message = fromHex(vector.messageHex)
    const signature = pqc.sign(pair.secretKey, message)
    assert.equal(sha256Hex(signature), sha256Hex(fromHex(vector.signatureHex)))
    assert.equal(pqc.verify(pair.publicKey, message, signature), true)
  })
}

for (const vector of coreDerivation.vectors) {
  test(`qbit Core derivation vector ${vector.name}`, () => {
    const { saltUtf8, infoPrefixUtf8 } = coreDerivation.derivation
    const info = Buffer.alloc(infoPrefixUtf8.length + 12)
    info.write(infoPrefixUtf8, 0, 'utf8')
    info.writeUInt32LE(vector.hkdf.account, infoPrefixUtf8.length)
    info.writeUInt32LE(vector.hkdf.change, infoPrefixUtf8.length + 4)
    info.writeUInt32LE(vector.hkdf.index, infoPrefixUtf8.length + 8)
    const masterSeed = fromHex(vector.masterSeedHex)
    const entropy = new Uint8Array(
      hkdfSync('sha256', masterSeed, Buffer.from(saltUtf8, 'utf8'), info, pqc.constants.MIN_ENTROPY)
    )
    assert.equal(toHex(entropy), vector.keygenEntropyHex)

    const derived = pqc.derivePQCKey(
      masterSeed,
      vector.hkdf.account,
      vector.hkdf.change,
      vector.hkdf.index
    )
    assert.equal(toHex(derived.pk32), vector.publicKeyHex)
    assert.equal(toHex(derived.sk64), vector.secretKeyHex)
    const pair = pqc.keygen(entropy)
    assert.equal(toHex(pair.publicKey), vector.publicKeyHex)

    const message = fromHex(vector.messageHex)
    const signature = pqc.sign(derived.sk64, message)
    assert.equal(sha256Hex(signature), vector.signatureSha256Hex)
    assert.equal(pqc.verify(derived.pk32, message, signature), true)
  })
}

test('qbit Core signature vectors verify, re-sign byte for byte, and reject swaps', () => {
  const pairs = new Map(
    Object.entries(coreSignatures.keys).map(([id, key]) => {
      // Core's generator calls keygen with 128 bytes of one fill value.
      const pair = pqc.keygen(new Uint8Array(128).fill(key.randomDataFill))
      assert.equal(toHex(pair.publicKey), key.publicKey, `key ${id}`)
      return [id, pair]
    })
  )
  assert.ok(coreSignatures.accept.length > 0 && coreSignatures.reject.length > 0)
  const signatures = new Map()
  for (const vector of coreSignatures.accept) {
    const pair = pairs.get(vector.key)
    const message = fromHex(vector.message)
    const signature = fromHex(vector.signature)
    signatures.set(vector.name, signature)
    assert.equal(pqc.verify(pair.publicKey, message, signature), true, vector.name)
    assert.equal(sha256Hex(pqc.sign(pair.secretKey, message)), sha256Hex(signature), vector.name)
  }
  for (const vector of coreSignatures.reject) {
    const signature = signatures.get(vector.signatureOf)
    assert.ok(signature, `${vector.name} names an accepted signature`)
    const pair = pairs.get(vector.key)
    assert.equal(pqc.verify(pair.publicKey, fromHex(vector.message), signature), false, vector.name)
  }
})
