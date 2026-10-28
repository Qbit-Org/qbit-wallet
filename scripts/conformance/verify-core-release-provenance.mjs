#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASE_PATTERN = /^v[0-9A-Za-z][0-9A-Za-z._-]*$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const FINGERPRINT_PATTERN = /^[0-9A-F]{40}$/
const BINDING = 'qbit-signed-release-tag-and-checksums-v1'
const scriptPath = fileURLToPath(import.meta.url)

export function parseOptions(args) {
  const known = new Set([
    '--source',
    '--repository',
    '--release',
    '--expected-commit',
    '--sha256-amd64',
    '--sha256-arm64',
    '--signer-fingerprint',
    '--checksum-signature-asset',
    '--output',
  ])
  const options = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--') continue
    if (!known.has(name)) throw new Error(`unknown option ${name}`)
    if (options.has(name)) throw new Error(`${name} may only be provided once`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    options.set(name, value)
    index += 1
  }
  for (const required of [
    '--source',
    '--repository',
    '--release',
    '--sha256-amd64',
    '--signer-fingerprint',
    '--checksum-signature-asset',
  ]) {
    if (!options.has(required)) throw new Error(`${required} is required`)
  }
  return options
}

function run(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (!result.error && result.status === 0) return `${result.stdout}${result.stderr}`
  const detail = [result.error?.message, result.stderr?.trim(), result.stdout?.trim()]
    .filter(Boolean)
    .join('\n')
  throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
}

function git(source, args, options) {
  return run('git', ['-C', source, ...args], options).trim()
}

export function validSigner(output, expectedFingerprint, label) {
  const statuses = output
    .split(/\r?\n/)
    .map(line => /^\[GNUPG:\] ([A-Z_]+)(?: (.*))?$/.exec(line.trim()))
    .filter(Boolean)
    .map(match => ({ name: match[1], fields: match[2]?.split(' ') || [] }))
  const signatureResults = new Set([
    'GOODSIG',
    'BADSIG',
    'EXPSIG',
    'EXPKEYSIG',
    'REVKEYSIG',
    'ERRSIG',
  ])
  const results = statuses.filter(status => signatureResults.has(status.name))
  if (results.length !== 1) {
    throw new Error(`${label} must contain exactly one GPG signature result`)
  }
  if (results[0].name !== 'GOODSIG') {
    throw new Error(`${label} has unacceptable GPG status ${results[0].name}`)
  }
  if (statuses.some(status => status.name === 'KEYREVOKED')) {
    throw new Error(`${label} has unacceptable GPG status KEYREVOKED`)
  }

  const validSignatures = statuses.filter(status => status.name === 'VALIDSIG')
  if (validSignatures.length !== 1) {
    throw new Error(`${label} must contain exactly one VALIDSIG status`)
  }
  if (validSignatures[0].fields[0] !== expectedFingerprint) {
    throw new Error(`${label} was not signed by pinned fingerprint ${expectedFingerprint}`)
  }
}

function archiveName(release, arch) {
  return `qbit-${release.replace(/^v/, '')}-${arch}-linux-gnu.tar.gz`
}

export function signedArchiveDigest(checksums, name) {
  const matches = checksums
    .split(/\r?\n/)
    .map(line => /^([0-9a-f]{64}) [ *](.+)$/.exec(line))
    .filter(match => match?.[2] === name)
  if (matches.length !== 1) {
    throw new Error(`signed SHA256SUMS must contain exactly one ${name} entry`)
  }
  return matches[0][1]
}

async function download(url, label) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`could not download ${label}: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) {
    throw new Error(`${label} has invalid size ${bytes.length}`)
  }
  return bytes
}

export async function verifyRelease(options) {
  const source = resolve(options.get('--source'))
  const repository = options.get('--repository')
  const release = options.get('--release')
  const expectedCommit = options.get('--expected-commit')
  const sha256Amd64 = options.get('--sha256-amd64')
  const sha256Arm64 = options.get('--sha256-arm64') || ''
  const signerFingerprint = options.get('--signer-fingerprint').toUpperCase()
  const checksumSignatureAsset = options.get('--checksum-signature-asset')

  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('--repository must be owner/repo')
  if (!RELEASE_PATTERN.test(release)) throw new Error('--release has an invalid tag format')
  if (!SHA256_PATTERN.test(sha256Amd64)) throw new Error('--sha256-amd64 must be lowercase SHA-256')
  if (sha256Arm64 && !SHA256_PATTERN.test(sha256Arm64)) {
    throw new Error('--sha256-arm64 must be lowercase SHA-256 when provided')
  }
  if (!FINGERPRINT_PATTERN.test(signerFingerprint)) {
    throw new Error('--signer-fingerprint must be a 40-character uppercase fingerprint')
  }
  if (expectedCommit && !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new Error('--expected-commit must be a full lowercase commit ID')
  }
  if (
    basename(checksumSignatureAsset) !== checksumSignatureAsset ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(checksumSignatureAsset)
  ) {
    throw new Error('--checksum-signature-asset must be a basename')
  }

  const expectedRemote = `https://github.com/${repository}.git`
  const remote = git(source, ['config', '--get', 'remote.origin.url'])
  if (remote !== expectedRemote) {
    throw new Error(`source remote mismatch: expected ${expectedRemote}, got ${remote}`)
  }
  if (git(source, ['cat-file', '-t', `refs/tags/${release}`]) !== 'tag') {
    throw new Error(`${release} must be an annotated tag`)
  }
  const commit = git(source, ['rev-parse', `refs/tags/${release}^{commit}`])
  if (git(source, ['rev-parse', 'HEAD']) !== commit) {
    throw new Error(`source HEAD does not match signed release tag target ${commit}`)
  }
  if (expectedCommit && commit !== expectedCommit) {
    throw new Error(`release tag target mismatch: expected ${expectedCommit}, got ${commit}`)
  }
  if (git(source, ['status', '--porcelain=v1', '--untracked-files=normal'])) {
    throw new Error('release source checkout must be clean')
  }

  // Keep the path short enough for gpg-agent's Unix-domain socket limit on macOS.
  const temporary = mkdtempSync(join(tmpdir(), 'qrp-'))
  const gpgHome = join(temporary, 'gnupg')
  try {
    chmodSync(temporary, 0o700)
    mkdirSync(gpgHome, { mode: 0o700 })
    const keyDirectory = join(source, 'contrib/keys/operator-keys/public-keys')
    const publicKeys = readdirSync(keyDirectory)
      .filter(name => name.endsWith('.asc'))
      .sort()
      .map(name => join(keyDirectory, name))
    if (publicKeys.length === 0) throw new Error('release source contains no operator public keys')
    const signerKey = publicKeys.find(key => {
      const metadata = run('gpg', ['--batch', '--show-keys', '--with-colons', key])
      return metadata
        .split(/\r?\n/)
        .some(line => line.startsWith('fpr:') && line.split(':')[9] === signerFingerprint)
    })
    if (!signerKey) {
      throw new Error(`release source does not contain pinned signer ${signerFingerprint}`)
    }
    run('gpg', ['--batch', '--no-tty', '--pinentry-mode', 'loopback', '--import', signerKey], {
      env: { GNUPGHOME: gpgHome },
    })

    const tagVerification = run(
      'git',
      ['-C', source, '-c', 'gpg.program=gpg', 'verify-tag', '--raw', release],
      { env: { GNUPGHOME: gpgHome } }
    )
    validSigner(tagVerification, signerFingerprint, 'release tag')

    const base = `https://github.com/${repository}/releases/download/${release}`
    const [checksumsBytes, signatureBytes] = await Promise.all([
      download(`${base}/SHA256SUMS`, 'SHA256SUMS'),
      download(`${base}/${checksumSignatureAsset}`, checksumSignatureAsset),
    ])
    const checksumsPath = join(temporary, 'SHA256SUMS')
    const signaturePath = join(temporary, checksumSignatureAsset)
    writeFileSync(checksumsPath, checksumsBytes)
    writeFileSync(signaturePath, signatureBytes)
    const checksumVerification = run(
      'gpg',
      ['--batch', '--status-fd=1', '--verify', signaturePath, checksumsPath],
      { env: { GNUPGHOME: gpgHome } }
    )
    validSigner(checksumVerification, signerFingerprint, 'release checksum manifest')

    const checksums = readFileSync(checksumsPath, 'utf8')
    const x64Name = archiveName(release, 'x86_64')
    const arm64Name = archiveName(release, 'aarch64')
    const signedAmd64 = signedArchiveDigest(checksums, x64Name)
    if (signedAmd64 !== sha256Amd64) {
      throw new Error(
        `amd64 archive digest mismatch: signed ${signedAmd64}, configured ${sha256Amd64}`
      )
    }
    if (sha256Arm64) {
      const signedArm64 = signedArchiveDigest(checksums, arm64Name)
      if (signedArm64 !== sha256Arm64) {
        throw new Error(
          `arm64 archive digest mismatch: signed ${signedArm64}, configured ${sha256Arm64}`
        )
      }
    }

    return {
      schemaVersion: 1,
      binding: BINDING,
      repository,
      tag: release,
      commit,
      releaseSignerFingerprint: signerFingerprint,
      checksumSignatureAsset,
      linuxX64ArchiveSha256: sha256Amd64,
      linuxArm64ArchiveSha256: sha256Arm64 || null,
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  const evidence = await verifyRelease(options)
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`
  const output = options.get('--output')
  if (output) writeFileSync(resolve(output), serialized)
  else process.stdout.write(serialized)
  return evidence
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().catch(error => {
    console.error(
      `[qbit-release-provenance] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  })
}
