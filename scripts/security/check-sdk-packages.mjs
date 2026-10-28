import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import YAML from 'yaml'

export const SDK_PACKAGE_PINS_FILE = 'scripts/security/sdk-package-pins.json'
// The SDK packages the conformance matrix fixture's derivation runs through.
export const MATRIX_SDK_PACKAGES = ['@qbit-oss/pqc', '@qbit-oss/protocol']
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function validateSdkPackagePins(pins) {
  if (!isMapping(pins) || pins.schemaVersion !== 1 || !Array.isArray(pins.packages)) {
    return [`${SDK_PACKAGE_PINS_FILE}: schemaVersion must be 1 with a packages list`]
  }
  const errors = []
  const names = new Set()
  pins.packages.forEach((pin, index) => {
    const label = `${SDK_PACKAGE_PINS_FILE}: packages[${index}]`
    if (!isMapping(pin)) {
      errors.push(`${label} must be an object`)
      return
    }
    if (typeof pin.package !== 'string' || !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(pin.package)) {
      errors.push(`${label}.package must be a scoped package name`)
    } else if (names.has(pin.package)) {
      errors.push(`${label}.package repeats ${pin.package}`)
    }
    names.add(pin.package)
    if (typeof pin.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
      errors.push(`${label}.version must be an exact x.y.z version`)
    }
    if (typeof pin.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity)) {
      errors.push(`${label}.integrity must be a sha512 SRI value`)
    }
    const provenance = isMapping(pin.provenance) ? pin.provenance : {}
    if (
      typeof provenance.repository !== 'string' ||
      typeof provenance.workflow !== 'string' ||
      typeof provenance.ref !== 'string' ||
      !/^[0-9a-f]{40}$/.test(provenance.commit ?? '')
    ) {
      errors.push(`${label}.provenance must name the repository, workflow, ref and commit`)
    }
    if (pin.files !== undefined) {
      const files = isMapping(pin.files) ? Object.entries(pin.files) : []
      if (files.length === 0) errors.push(`${label}.files must pin at least one file`)
      for (const [file, digest] of files) {
        if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(file) || file.includes('..')) {
          errors.push(`${label}.files has an invalid path: ${file}`)
        }
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
          errors.push(`${label}.files.${file} must be a sha256 hex digest`)
        }
      }
    }
  })
  return errors
}

/**
 * The lockfile must resolve each pinned package exactly once, at the pinned
 * version and registry integrity, and every importer that names it must ask
 * for that exact version, so no other copy can be installed. Returns the
 * importers that depend on each package.
 */
export function auditSdkLockfile(lockfileText, pins) {
  const errors = []
  const consumers = new Map()
  const lockfile = YAML.parse(lockfileText)
  for (const pin of pins.packages) {
    const expectedKey = `/${pin.package}@${pin.version}`
    const resolutions = Object.keys(lockfile?.packages ?? {}).filter(key =>
      key.startsWith(`/${pin.package}@`)
    )
    if (resolutions.length !== 1 || resolutions[0] !== expectedKey) {
      errors.push(
        `pnpm-lock.yaml must resolve ${pin.package} only as ${expectedKey}, found ${JSON.stringify(resolutions)}`
      )
    }
    const integrity = lockfile?.packages?.[expectedKey]?.resolution?.integrity
    if (integrity !== pin.integrity) {
      errors.push(
        `pnpm-lock.yaml integrity for ${expectedKey} is ${JSON.stringify(integrity)}, pinned ${pin.integrity}`
      )
    }
    const importers = []
    for (const [importer, sections] of Object.entries(lockfile?.importers ?? {})) {
      for (const section of DEPENDENCY_SECTIONS) {
        const entry = sections?.[section]?.[pin.package]
        if (entry === undefined) continue
        importers.push(importer)
        if (entry?.specifier !== pin.version || entry?.version !== pin.version) {
          errors.push(
            `pnpm-lock.yaml importer ${importer} ${section} must take ${pin.package} at exactly ${pin.version}, found specifier ${JSON.stringify(entry?.specifier)} resolved to ${JSON.stringify(entry?.version)}`
          )
        }
      }
    }
    if (importers.length === 0) {
      errors.push(`pnpm-lock.yaml has no importer that depends on ${pin.package}`)
    }
    consumers.set(pin.package, importers)
  }
  return { errors, consumers }
}

function parseSha256Sums(text, label) {
  const errors = []
  const sums = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line)
    if (!match || sums.has(match[2])) {
      errors.push(`${label} has a malformed or repeated line: ${line}`)
      continue
    }
    sums.set(match[2], match[1])
  }
  return { errors, sums }
}

/**
 * The installed package must be the pinned version. Each pinned file must
 * match the digest committed here and, when the package ships a SHA256SUMS
 * beside it, that file's entry for it, so a different tarball cannot change
 * those bytes without a reviewed change to the pin.
 */
export function auditSdkPackageFiles(packageRoot, pin, readFile = readFileSync) {
  const errors = []
  const manifest = JSON.parse(readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.name !== pin.package || manifest.version !== pin.version) {
    errors.push(
      `installed ${manifest.name}@${manifest.version} is not the pinned ${pin.package}@${pin.version}`
    )
  }
  const sumsByDirectory = new Map()
  for (const [file, pinned] of Object.entries(pin.files ?? {})) {
    const actual = sha256Hex(readFile(join(packageRoot, file)))
    if (actual !== pinned) {
      errors.push(
        `${pin.package} ${file} sha256 ${actual} does not match ${SDK_PACKAGE_PINS_FILE} (${pinned})`
      )
    }
    const directory = dirname(file)
    if (!sumsByDirectory.has(directory)) {
      let text
      try {
        text = readFile(join(packageRoot, directory, 'SHA256SUMS'), 'utf8')
      } catch {
        text = undefined
      }
      const label = `${pin.package} ${directory}/SHA256SUMS`
      const parsed = text === undefined ? undefined : parseSha256Sums(text, label)
      if (parsed) errors.push(...parsed.errors)
      sumsByDirectory.set(directory, parsed?.sums)
    }
    const sums = sumsByDirectory.get(directory)
    const name = directory === '.' ? file : file.slice(directory.length + 1)
    if (sums && sums.get(name) !== actual) {
      errors.push(
        `${pin.package} ${file} sha256 ${actual} does not match its ${directory}/SHA256SUMS`
      )
    }
  }
  // A SHA256SUMS that lists a file the pin leaves out would let that file
  // change unreviewed.
  for (const [directory, sums] of sumsByDirectory) {
    for (const name of sums?.keys() ?? []) {
      const file = directory === '.' ? name : `${directory}/${name}`
      if (!Object.hasOwn(pin.files, file)) {
        errors.push(`${pin.package} ${directory}/SHA256SUMS lists ${file}, which the pin does not`)
      }
    }
  }
  return errors
}

/** The directory each consumer resolves `name` to. */
export function sdkPackageRoots(repoRoot, name, consumers) {
  return consumers.map(consumer => {
    const require = createRequire(join(repoRoot, consumer, 'package.json'))
    return { consumer, root: dirname(require.resolve(`${name}/package.json`)) }
  })
}

/**
 * `{ name: 'version integrity' }` for the named pinned packages, the SDK
 * identity a conformance fixture records.
 */
export function sdkPackageIdentities(pins, names) {
  return Object.fromEntries(
    names.map(name => {
      const pin = pins.packages.find(entry => entry.package === name)
      if (!pin) throw new Error(`${SDK_PACKAGE_PINS_FILE} does not pin ${name}`)
      return [name, `${pin.version} ${pin.integrity}`]
    })
  )
}

export function checkSdkPackages(repoRoot) {
  const pins = JSON.parse(readFileSync(join(repoRoot, SDK_PACKAGE_PINS_FILE), 'utf8'))
  const pinErrors = validateSdkPackagePins(pins)
  if (pinErrors.length > 0) return { errors: pinErrors, pins, roots: new Map() }
  const lockfileText = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const { errors, consumers } = auditSdkLockfile(lockfileText, pins)
  const roots = new Map()
  for (const pin of pins.packages) {
    const resolved = sdkPackageRoots(repoRoot, pin.package, consumers.get(pin.package) ?? [])
    const distinct = [...new Set(resolved.map(({ root }) => root))]
    if (distinct.length > 1) {
      errors.push(
        `${pin.package} must resolve to one installed copy, found ${resolved.map(({ consumer, root }) => `${consumer} -> ${root}`).join(', ')}`
      )
    }
    for (const root of distinct) errors.push(...auditSdkPackageFiles(root, pin))
    if (distinct.length === 1) roots.set(pin.package, distinct[0])
  }
  return { errors, pins, roots }
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === scriptPath) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const { errors, pins } = checkSdkPackages(repoRoot)
  if (errors.length > 0) {
    console.error(`SDK package check failed:\n- ${errors.join('\n- ')}`)
    process.exitCode = 1
  } else {
    for (const pin of pins.packages) {
      const files = Object.keys(pin.files ?? {})
      console.log(
        `${pin.package}@${pin.version} matches ${SDK_PACKAGE_PINS_FILE}: lockfile integrity and one installed copy${files.length > 0 ? `, and ${files.join(', ')} digests` : ''}`
      )
    }
  }
}
