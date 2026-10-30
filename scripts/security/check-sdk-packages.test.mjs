import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditSdkAttestations,
  auditSdkLockfile,
  auditSdkPackageFiles,
  checkSdkAttestations,
  checkSdkPackages,
  SDK_PACKAGE_PINS_FILE,
  sdkAttestationsUrl,
  validateSdkPackagePins,
} from './check-sdk-packages.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pins = JSON.parse(readFileSync(join(repoRoot, SDK_PACKAGE_PINS_FILE), 'utf8'))
const pqcPin = pins.packages.find(pin => pin.package === '@qbit-oss/pqc')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// The registry's reply for @qbit-oss/pqc@0.1.0, recorded from
// https://registry.npmjs.org/-/npm/v1/attestations/@qbit-oss%2fpqc@0.1.0, and
// the pin it was checked against by hand when 0.1.0 was adopted.
const recordedAttestations = JSON.parse(
  readFileSync(
    join(repoRoot, 'scripts/security/fixtures/npm-attestations-qbit-oss-pqc-0.1.0.json'),
    'utf8'
  )
)
const recordedPin = {
  package: '@qbit-oss/pqc',
  version: '0.1.0',
  integrity:
    'sha512-NZAWoRggBtQHdCyXFfA4odcgnxedrwV57nZMHkhutS/UnPpzNBGwVPUMQcmIfxlF9IPU5Q0FRtJ5VnoQ59vqCA==',
  provenance: {
    repository: 'Qbit-Org/qbit-pqc',
    workflow: '.github/workflows/publish.yml',
    ref: 'refs/tags/v0.1.0',
    commit: 'be0a0f928dfe4d65602e7cfcbff95e13f3d0a6ce',
  },
}
const SLSA = 'https://slsa.dev/provenance/v1'

/** The recorded reply with `edit` applied to the decoded statement of each `predicateType` one. */
function editedAttestations(predicateType, edit) {
  const body = structuredClone(recordedAttestations)
  for (const attestation of body.attestations) {
    if (attestation.predicateType !== predicateType) continue
    const envelope = attestation.bundle.dsseEnvelope
    const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'))
    edit(statement)
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64')
  }
  return body
}

function lockfile(pin, { integrity = pin.integrity, extraVersion, specifier = pin.version } = {}) {
  const packages = [
    `  /${pin.package}@${pin.version}:`,
    `    resolution: {integrity: ${integrity}}`,
    '    dev: false',
  ]
  if (extraVersion) {
    packages.push(
      `  /${pin.package}@${extraVersion}:`,
      `    resolution: {integrity: ${pin.integrity}}`,
      '    dev: false'
    )
  }
  return [
    "lockfileVersion: '6.1'",
    'importers:',
    '  packages/keyring-service:',
    '    dependencies:',
    `      '${pin.package}':`,
    `        specifier: ${specifier}`,
    `        version: ${pin.version}`,
    'packages:',
    ...packages,
    '',
  ].join('\n')
}

function packageDir({ wasm = 'wasm bytes', sums } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-package-'))
  mkdirSync(join(dir, 'wasm'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: pqcPin.package, version: pqcPin.version })
  )
  writeFileSync(join(dir, 'wasm/pqc.mjs'), 'loader')
  writeFileSync(join(dir, 'wasm/pqc.wasm'), wasm)
  writeFileSync(
    join(dir, 'wasm/SHA256SUMS'),
    sums ?? `${sha256('loader')}  pqc.mjs\n${sha256(wasm)}  pqc.wasm\n`
  )
  return dir
}

const pinFor = (wasm = 'wasm bytes') => ({
  ...pqcPin,
  files: { 'wasm/pqc.mjs': sha256('loader'), 'wasm/pqc.wasm': sha256(wasm) },
})

test('the installed SDK packages match the committed pins', () => {
  const { errors, roots } = checkSdkPackages(repoRoot)
  assert.deepEqual(errors, [])
  assert.deepEqual([...roots.keys()].sort(), [
    '@qbit-oss/api',
    '@qbit-oss/pqc',
    '@qbit-oss/protocol',
  ])
  for (const [name, root] of roots) assert.ok(root.endsWith(join('node_modules', name)), name)
})

test('each pin must name an exact version, a sha512 integrity, and its provenance', () => {
  assert.deepEqual(validateSdkPackagePins(pins), [])
  const one = changes => ({ schemaVersion: 1, packages: [{ ...pqcPin, ...changes }] })
  assert.match(validateSdkPackagePins(one({ version: '^0.1.0' })).join('\n'), /exact x\.y\.z/)
  assert.match(validateSdkPackagePins(one({ integrity: 'sha1-abc' })).join('\n'), /sha512 SRI/)
  assert.match(
    validateSdkPackagePins(one({ provenance: { repository: 'Qbit-Org/qbit-pqc' } })).join('\n'),
    /provenance must name/
  )
  assert.match(
    validateSdkPackagePins(one({ files: { '../escape': '0'.repeat(64) } })).join('\n'),
    /invalid path/
  )
  assert.match(
    validateSdkPackagePins({ schemaVersion: 1, packages: [pqcPin, pqcPin] }).join('\n'),
    /repeats @qbit-oss\/pqc/
  )
})

test('the lockfile must resolve one copy at the pinned version and integrity', () => {
  const only = { schemaVersion: 1, packages: [pqcPin] }
  const audit = options => auditSdkLockfile(lockfile(pqcPin, options), only)
  assert.deepEqual(audit().errors, [])
  assert.deepEqual(audit().consumers.get(pqcPin.package), ['packages/keyring-service'])
  assert.match(
    audit({ integrity: `sha512-${'A'.repeat(86)}==` }).errors.join('\n'),
    /integrity for .* pinned/
  )
  assert.match(
    audit({ extraVersion: '99.0.0' }).errors.join('\n'),
    /must resolve @qbit-oss\/pqc only as/
  )
  assert.ok(
    audit({ specifier: `^${pqcPin.version}` })
      .errors.join('\n')
      .includes(`must take @qbit-oss/pqc at exactly ${pqcPin.version}`)
  )
})

test('pinned files must match both the package SHA256SUMS and the committed digests', () => {
  const dirs = []
  const audit = (options, filesPin) => {
    const dir = packageDir(options)
    dirs.push(dir)
    return auditSdkPackageFiles(dir, filesPin).join('\n')
  }
  try {
    assert.equal(audit({}, pinFor()), '')
    // A tarball whose own SHA256SUMS agrees with a different WASM still
    // fails against the committed digest.
    assert.match(audit({ wasm: 'other wasm' }, pinFor()), /does not match .*sdk-package-pins\.json/)
    assert.doesNotMatch(
      audit({ wasm: 'other wasm' }, pinFor()),
      /does not match its wasm\/SHA256SUMS/
    )
    // A WASM that no longer matches the package's own SHA256SUMS fails too.
    assert.match(
      audit({ sums: `${sha256('loader')}  pqc.mjs\n${'0'.repeat(64)}  pqc.wasm\n` }, pinFor()),
      /pqc\.wasm sha256 .* does not match its wasm\/SHA256SUMS/
    )
    // So does a SHA256SUMS entry the pin does not cover.
    assert.match(
      audit(
        {
          sums: `${sha256('loader')}  pqc.mjs\n${sha256('wasm bytes')}  pqc.wasm\n${'1'.repeat(64)}  extra.wasm\n`,
        },
        pinFor()
      ),
      /lists wasm\/extra\.wasm, which the pin does not/
    )
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

test('the lockfile must not resolve an @qbit-oss package without a pin', () => {
  const only = { schemaVersion: 1, packages: [pqcPin] }
  const unpinned = lockfile(pqcPin).replace(
    'packages:\n',
    "      '@qbit-oss/other':\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  /@qbit-oss/other@1.0.0:\n    resolution: {integrity: sha512-x}\n    dev: false\n"
  )
  const errors = auditSdkLockfile(unpinned, only).errors.join('\n')
  assert.match(errors, /resolves \/@qbit-oss\/other@1\.0\.0, but .* does not pin @qbit-oss\/other/)
  assert.match(errors, /importer packages\/keyring-service dependencies takes @qbit-oss\/other/)
  // A transitive copy, which no importer names, is caught by its package key.
  const transitive = lockfile(pqcPin).concat(
    '  /@qbit-oss/other@2.0.0:\n    resolution: {integrity: sha512-x}\n    dev: false\n'
  )
  assert.match(
    auditSdkLockfile(transitive, only).errors.join('\n'),
    /resolves \/@qbit-oss\/other@2\.0\.0/
  )
  // So is one taken from a tarball URL, by its name.
  const tarball = lockfile(pqcPin).concat(
    "  registry.example/other.tgz:\n    resolution: {tarball: 'https://registry.example/other.tgz'}\n    name: '@qbit-oss/other'\n    version: 3.0.0\n    dev: false\n"
  )
  assert.match(
    auditSdkLockfile(tarball, only).errors.join('\n'),
    /resolves registry\.example\/other\.tgz, but .* does not pin @qbit-oss\/other/
  )
  // The repository's own lockfile pins every @qbit-oss package it resolves.
  const repoLockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  assert.deepEqual(auditSdkLockfile(repoLockfile, pins).errors, [])
})

test('the recorded registry attestation matches the pin it was adopted with', () => {
  assert.equal(
    sdkAttestationsUrl(recordedPin),
    'https://registry.npmjs.org/-/npm/v1/attestations/@qbit-oss%2fpqc@0.1.0'
  )
  assert.deepEqual(auditSdkAttestations(recordedPin, recordedAttestations), [])
})

test('an attestation that does not match the pin fails', () => {
  const audit = (body, pin = recordedPin) => auditSdkAttestations(pin, body).join('\n')
  // Another tarball: both the publish and the provenance subjects name it.
  const otherIntegrity = `sha512-${'A'.repeat(86)}==`
  const wrongDigest = audit(recordedAttestations, { ...recordedPin, integrity: otherIntegrity })
  assert.match(wrongDigest, /publish\/v0\.1 attestation subject .* pinned integrity/)
  assert.match(wrongDigest, /provenance\/v1 attestation subject .* pinned integrity/)
  assert.match(
    audit(
      editedAttestations(SLSA, statement => {
        statement.subject[0].digest.sha512 = '00'.repeat(64)
      })
    ),
    /provenance\/v1 attestation subject .* is not pkg:npm\/%40qbit-oss\/pqc@0\.1\.0/
  )
  assert.match(
    audit(
      editedAttestations(SLSA, statement => {
        statement.subject[0].name = 'pkg:npm/%40qbit-oss/pqc@0.1.1'
      })
    ),
    /attestation subject/
  )
  const workflowEdit = (field, value) =>
    editedAttestations(SLSA, statement => {
      statement.predicate.buildDefinition.externalParameters.workflow[field] = value
    })
  assert.match(
    audit(workflowEdit('repository', 'https://github.com/someone/qbit-pqc')),
    /provenance repository is "https:\/\/github\.com\/someone\/qbit-pqc", .* expects "https:\/\/github\.com\/Qbit-Org\/qbit-pqc"/
  )
  assert.match(
    audit(workflowEdit('path', '.github/workflows/other.yml')),
    /provenance workflow is "\.github\/workflows\/other\.yml"/
  )
  assert.match(
    audit(workflowEdit('ref', 'refs/heads/main')),
    /provenance ref is "refs\/heads\/main", .* expects "refs\/tags\/v0\.1\.0"/
  )
  assert.match(
    audit(
      editedAttestations(SLSA, statement => {
        statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(
          40
        )
      })
    ),
    /provenance commit is "f{40}", .* expects "be0a0f928dfe4d65602e7cfcbff95e13f3d0a6ce"/
  )
  assert.match(
    audit(
      editedAttestations(SLSA, statement => {
        statement.predicate.buildDefinition.buildType = 'https://example.com/other-builder'
      })
    ),
    /provenance build type/
  )
  // The pin side: a pin edited away from what the registry attests fails too.
  assert.match(
    audit(recordedAttestations, {
      ...recordedPin,
      provenance: { ...recordedPin.provenance, commit: '1'.repeat(40) },
    }),
    /provenance commit is "be0a0f928dfe4d65602e7cfcbff95e13f3d0a6ce", .* expects "1{40}"/
  )
  // A listing whose payload states another predicate type is refused.
  const relabelled = structuredClone(recordedAttestations)
  relabelled.attestations[0].predicateType = SLSA
  assert.match(audit(relabelled), /states .* but is listed as/)
})

test('a version without provenance fails', () => {
  const missing = /has no npm provenance attestation/
  assert.match(auditSdkAttestations(recordedPin, undefined).join('\n'), missing)
  assert.match(auditSdkAttestations(recordedPin, { attestations: [] }).join('\n'), missing)
  const publishOnly = {
    attestations: recordedAttestations.attestations.filter(item => item.predicateType !== SLSA),
  }
  assert.match(
    auditSdkAttestations(recordedPin, publishOnly).join('\n'),
    /must have one https:\/\/slsa\.dev\/provenance\/v1 attestation, found 0/
  )
  const unsigned = structuredClone(recordedAttestations)
  delete unsigned.attestations[1].bundle.dsseEnvelope
  assert.match(
    auditSdkAttestations(recordedPin, unsigned).join('\n'),
    /attestation 1 is not an in-toto statement/
  )
})

test('the networked check reads each pin from the registry and fails closed', async () => {
  const only = { schemaVersion: 1, packages: [recordedPin] }
  const requested = []
  const reply = (status, body) => async url => {
    requested.push(url)
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  }
  assert.deepEqual(await checkSdkAttestations(only, reply(200, recordedAttestations)), [])
  assert.deepEqual(requested, [sdkAttestationsUrl(recordedPin)])
  assert.match(
    (await checkSdkAttestations(only, reply(404))).join('\n'),
    /has no npm provenance attestation/
  )
  assert.match(
    (await checkSdkAttestations(only, reply(503))).join('\n'),
    /attestations could not be read: .* answered HTTP 503/
  )
  const offline = async () => {
    throw new TypeError('fetch failed')
  }
  assert.match(
    (await checkSdkAttestations(only, offline)).join('\n'),
    /attestations could not be read: fetch failed/
  )
})
