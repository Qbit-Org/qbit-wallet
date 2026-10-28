import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')
const extensionDirectory = join(repoRoot, 'apps', 'extension')
const extensionPackage = JSON.parse(
  readFileSync(join(extensionDirectory, 'package.json'), 'utf8')
)
const defaultArtifactVersion = extensionPackage.version.split('-beta')[0]
const args = new Set(process.argv.slice(2))
const artifactVersionArg = process.argv
  .slice(2)
  .find(argument => argument.startsWith('--artifact-version='))
const artifactVersion = artifactVersionArg?.slice('--artifact-version='.length) || defaultArtifactVersion
const expectedNode = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim()
const actualNode = process.version.replace(/^v/, '')
const expectedPnpm = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  .packageManager.split('@')[1]
const actualPnpm = execFileSync('corepack', ['pnpm', '--version'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim()

if (actualNode !== expectedNode && !args.has('--allow-toolchain-mismatch')) {
  throw new Error(
    `reproducibility gate requires Node ${expectedNode}, running ${actualNode}; ` +
      'use the pinned toolchain or explicitly mark a non-canonical local drill with ' +
      '--allow-toolchain-mismatch'
  )
}
if (actualPnpm !== expectedPnpm) {
  throw new Error(`reproducibility gate requires pnpm ${expectedPnpm}, running ${actualPnpm}`)
}

const artifactName = `qbit-chrome-mv3-v${artifactVersion}.zip`
const artifactPath = join(extensionDirectory, 'dist', artifactName)
const artifactPaths = [
  artifactPath,
  `${artifactPath}.manifest.json`,
  `${artifactPath}.sha256`,
]
const evidenceRoot = join(repoRoot, '.context', 'reproducibility', 'extension')
const buildEnvironment = {
  ...process.env,
  LC_ALL: 'C',
  SOURCE_DATE_EPOCH: '315532800',
  TZ: 'UTC',
}

function runPnpm(commandArgs) {
  execFileSync('corepack', ['pnpm', ...commandArgs], {
    cwd: repoRoot,
    env: buildEnvironment,
    stdio: 'inherit',
  })
}

function cleanGeneratedBuildState() {
  for (const generatedPath of [
    join(extensionDirectory, 'dist', 'chrome'),
    join(repoRoot, 'node_modules', '.cache'),
    join(extensionDirectory, 'node_modules', '.cache'),
  ]) {
    rmSync(generatedPath, { force: true, recursive: true })
  }
}

function snapshotBuild(buildNumber) {
  const destination = join(evidenceRoot, `build-${buildNumber}`)
  rmSync(destination, { force: true, recursive: true })
  mkdirSync(destination, { recursive: true })
  for (const source of artifactPaths) {
    copyFileSync(source, join(destination, basename(source)))
  }
  return artifactPaths.map(source => readFileSync(source))
}

if (!args.has('--skip-prepare')) {
  runPnpm(['test:e2e:prepare'])
}

rmSync(evidenceRoot, { force: true, recursive: true })
const builds = []
for (const buildNumber of [1, 2]) {
  cleanGeneratedBuildState()
  runPnpm([
    '--filter',
    'qbit-extension',
    'run',
    'package:test',
    '--',
    '--artifact-version',
    artifactVersion,
  ])
  builds.push(snapshotBuild(buildNumber))
}

for (let index = 0; index < artifactPaths.length; index += 1) {
  if (!builds[0][index].equals(builds[1][index])) {
    throw new Error(`reproducibility mismatch: ${artifactPaths[index]}`)
  }
}

const manifest = JSON.parse(readFileSync(`${artifactPath}.manifest.json`, 'utf8'))
console.log('')
console.log('Reproducible extension build: PASS')
console.log(`Node: ${actualNode}${actualNode === expectedNode ? ' (pinned)' : ' (non-canonical local drill)'}`)
console.log(`pnpm: ${actualPnpm} (pinned)`)
console.log(`Artifact: ${artifactName}`)
console.log(`SHA-256: ${manifest.artifact.sha256}`)
console.log(`Evidence: ${evidenceRoot}`)
