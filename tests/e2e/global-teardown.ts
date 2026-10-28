import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { repositoryRoot } from './support/paths'

const execFileAsync = promisify(execFile)

export default async function globalTeardown(): Promise<void> {
  if (process.env['QBIT_E2E_KEEP_REGTEST'] === '1') return

  await execFileAsync('bash', ['scripts/regtest/down'], {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  })
}
