import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SOURCE_FILE = /\.(?:cjs|js|mjs|ts|tsx)$/
const GENERATED_DIRECTORY = /(?:^|\/)(?:coverage|dist|lib|node_modules)\//

export function trackedSourceFiles(repoRoot) {
  const submoduleStatus = execFileSync('git', ['submodule', 'status', '--recursive'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const invalidSubmodules = submoduleStatus
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(Boolean)
    .filter(line => !line.startsWith(' '))
  if (invalidSubmodules.length > 0) {
    throw new Error(
      `lint cannot inspect missing, drifted, or conflicted submodules:\n${invalidSubmodules.join('\n')}`
    )
  }

  return execFileSync('git', ['ls-files', '--cached', '--recurse-submodules', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(file => SOURCE_FILE.test(file) && !GENERATED_DIRECTORY.test(file))
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function runCheck(label, command, args, repoRoot) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) {
    console.error(`Failed to start ${label}: ${result.error.message}`)
    return false
  }
  return result.status === 0
}

export function runLint(repoRoot, { repoOnly = false } = {}) {
  let passed = true
  if (!repoOnly) {
    passed =
      runCheck('lint:workspaces', 'corepack', ['pnpm', 'run', 'lint:workspaces'], repoRoot) &&
      passed
  }

  const sourceFiles = trackedSourceFiles(repoRoot)
  passed =
    runCheck(
      'lint:repo',
      'corepack',
      ['pnpm', 'exec', 'eslint', '--no-eslintrc', '--config', '.eslintrc.repo.cjs', ...sourceFiles],
      repoRoot
    ) && passed
  return passed
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === scriptPath) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--repo-only')) {
    throw new Error(`unsupported arguments: ${args.join(' ')}`)
  }
  if (!runLint(repoRoot, { repoOnly: args[0] === '--repo-only' })) {
    process.exitCode = 1
  }
}
