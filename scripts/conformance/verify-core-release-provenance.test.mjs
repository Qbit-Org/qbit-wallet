import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseOptions,
  signedArchiveDigest,
  validSigner,
} from './verify-core-release-provenance.mjs'

const requiredArgs = [
  '--source',
  '/tmp/qbit',
  '--repository',
  'Qbit-Org/qbit',
  '--release',
  'v0.1.2-testnet4',
  '--sha256-amd64',
  '1'.repeat(64),
  '--signer-fingerprint',
  'A'.repeat(40),
  '--checksum-signature-asset',
  'SHA256SUMS.operator-02.asc',
]

test('release verifier options fail closed on missing, duplicate, and unknown inputs', () => {
  assert.doesNotThrow(() => parseOptions(requiredArgs))
  assert.throws(
    () => parseOptions(requiredArgs.slice(0, -2)),
    /checksum-signature-asset is required/
  )
  assert.throws(
    () => parseOptions([...requiredArgs, '--release', 'v0.1.3-testnet4']),
    /may only be provided once/
  )
  assert.throws(() => parseOptions([...requiredArgs, '--source-ref', 'main']), /unknown option/)
})

test('signed archive lookup requires one exact checksum entry', () => {
  const name = 'qbit-0.1.2-testnet4-x86_64-linux-gnu.tar.gz'
  const digest = 'a'.repeat(64)
  assert.equal(signedArchiveDigest(`${digest}  ${name}\n`, name), digest)
  assert.throws(() => signedArchiveDigest('', name), /exactly one/)
  assert.throws(
    () => signedArchiveDigest(`${digest}  ${name}\n${digest} *${name}\n`, name),
    /exactly one/
  )
})

test('signature status must contain the pinned full fingerprint', () => {
  const fingerprint = 'B'.repeat(40)
  const valid = [
    `[GNUPG:] GOODSIG ${fingerprint.slice(-16)} Qbit%20Release`,
    `[GNUPG:] VALIDSIG ${fingerprint} 2026-07-01 1782864000 0 4 0 22 8 00 ${fingerprint}`,
  ].join('\n')

  assert.doesNotThrow(() => validSigner(valid, fingerprint, 'tag'))
  assert.doesNotThrow(() =>
    validSigner(`${valid}\n[GNUPG:] KEYEXPIRED 1782864000`, fingerprint, 'tag')
  )
  assert.throws(
    () => validSigner(`${valid}\n[GNUPG:] KEYREVOKED`, fingerprint, 'tag'),
    /unacceptable GPG status KEYREVOKED/
  )
  assert.throws(
    () => validSigner(valid.replaceAll(fingerprint, 'C'.repeat(40)), fingerprint, 'tag'),
    /was not signed by pinned fingerprint/
  )
})

test('signature status rejects bad, expired, revoked, or unverifiable signatures by status', () => {
  const fingerprint = 'B'.repeat(40)
  const validSig = `[GNUPG:] VALIDSIG ${fingerprint} 2026-07-01 1782864000 0 4 0 22 8 00 ${fingerprint}`
  const keyId = fingerprint.slice(-16)
  const signatureFailures = {
    BADSIG: `${keyId} Qbit%20Release`,
    EXPSIG: `${keyId} Qbit%20Release`,
    EXPKEYSIG: `${keyId} Qbit%20Release`,
    REVKEYSIG: `${keyId} Qbit%20Release`,
    ERRSIG: `${keyId} 22 8 00 1782864000 9 ${fingerprint}`,
  }

  for (const [status, fields] of Object.entries(signatureFailures)) {
    assert.throws(
      () => validSigner(`[GNUPG:] ${status} ${fields}\n${validSig}`, fingerprint, 'tag'),
      new RegExp(`unacceptable GPG status ${status}`)
    )
  }
})

test('signature status rejects missing, multiple, or mixed signature results', () => {
  const fingerprint = 'B'.repeat(40)
  const goodSig = `[GNUPG:] GOODSIG ${fingerprint.slice(-16)} Qbit%20Release`
  const validSig = `[GNUPG:] VALIDSIG ${fingerprint} 2026-07-01 1782864000 0 4 0 22 8 00 ${fingerprint}`

  assert.throws(() => validSigner(validSig, fingerprint, 'tag'), /exactly one GPG signature result/)
  assert.throws(
    () => validSigner(`${goodSig}\n${goodSig}\n${validSig}`, fingerprint, 'tag'),
    /exactly one GPG signature result/
  )
  assert.throws(
    () =>
      validSigner(
        `${goodSig}\n[GNUPG:] REVKEYSIG ${fingerprint.slice(-16)} Qbit%20Release\n${validSig}`,
        fingerprint,
        'tag'
      ),
    /exactly one GPG signature result/
  )
  assert.throws(
    () => validSigner(`${goodSig}\n${validSig}\n${validSig}`, fingerprint, 'tag'),
    /exactly one VALIDSIG status/
  )
})

test('signature status rejects a different signing subkey under the pinned primary key', () => {
  const fingerprint = 'B'.repeat(40)
  const subkeyFingerprint = 'C'.repeat(40)
  const status = [
    `[GNUPG:] GOODSIG ${subkeyFingerprint.slice(-16)} Qbit%20Release`,
    `[GNUPG:] VALIDSIG ${subkeyFingerprint} 2026-07-01 1782864000 0 4 0 22 8 00 ${fingerprint}`,
  ].join('\n')

  assert.throws(
    () => validSigner(status, fingerprint, 'tag'),
    /was not signed by pinned fingerprint/
  )
})
