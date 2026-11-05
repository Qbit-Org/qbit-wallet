import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const repositoryRoot = resolve(process.env['QBIT_E2E_REPOSITORY_ROOT'] || process.cwd())
// QBIT_E2E_EXTENSION_DIR points the harness at another unpacked build.
export const extensionDist = resolve(
  process.env['QBIT_E2E_EXTENSION_DIR'] || resolve(repositoryRoot, 'apps/extension/dist/chrome')
)

export function assertRepositoryRoot(): void {
  if (!existsSync(resolve(repositoryRoot, 'pnpm-workspace.yaml'))) {
    throw new Error(
      `Qbit e2e tests must run from the repository root; pnpm-workspace.yaml was not found under ${repositoryRoot}`
    )
  }
}
