import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditSdkLockfile,
  auditSdkPackageFiles,
  checkSdkPackages,
  SDK_PACKAGE_PINS_FILE,
  validateSdkPackagePins,
} from './check-sdk-packages.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pins = JSON.parse(readFileSync(join(repoRoot, SDK_PACKAGE_PINS_FILE), 'utf8'))
const pqcPin = pins.packages.find(pin => pin.package === '@qbit-oss/pqc')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

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
    audit({ extraVersion: '0.1.1' }).errors.join('\n'),
    /must resolve @qbit-oss\/pqc only as/
  )
  assert.match(
    audit({ specifier: '^0.1.0' }).errors.join('\n'),
    /must take @qbit-oss\/pqc at exactly 0\.1\.0/
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
