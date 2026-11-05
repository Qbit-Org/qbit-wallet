import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { repositoryRoot } from '../e2e/support/paths'

/**
 * #134 removed 344 translation strings per language. The shipped build logs
 * only errors, so a missing string shows its raw key without a console
 * warning, and the screen sweep cannot see it. This reads the sources: no
 * key removed since 1.0.7 may still appear in live code, and every key a
 * literal t('...') call uses must exist in every language.
 */

const LOCALES_DIR = join(repositoryRoot, 'apps/extension/src/_locales')
// Missing in 1.0.7 already, on screens 1.0.8 does not ship or reach.
const KNOWN_MISSING = new Set(['Back', 'Cancel', 'Continue', 'all_networks', 'utxo'])

function liveSources(): string[] {
  return execFileSync('git', ['ls-files', 'apps/extension/src', 'packages/*/src'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(file => /\.(ts|tsx)$/.test(file) && !file.includes('.test.'))
    .map(file =>
      readFileSync(join(repositoryRoot, file), 'utf8')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
    )
}

test('no translation key removed since 1.0.7 is still used, and every used key exists in every language', () => {
  const sources = liveSources()
  const v107 = JSON.parse(
    execFileSync('git', ['show', 'v1.0.7:apps/extension/src/_locales/en/messages.json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
  ) as Record<string, unknown>
  const current = JSON.parse(
    readFileSync(join(LOCALES_DIR, 'en', 'messages.json'), 'utf8')
  ) as Record<string, unknown>
  const removed = new Set(Object.keys(v107).filter(key => !(key in current)))

  const literals = new Set<string>()
  const used = new Set<string>()
  for (const source of sources) {
    for (const [, literal] of source.matchAll(/['"`]([a-z][a-z0-9_]*_[a-z0-9_]+)['"`]/g))
      literals.add(literal!)
    for (const [, key] of source.matchAll(/(?<![\w.$])t\(\s*['"]([A-Za-z0-9_]+)['"]/g))
      used.add(key!)
  }
  expect(
    [...removed].filter(key => literals.has(key)),
    'removed keys still in live code'
  ).toEqual([])

  for (const locale of readdirSync(LOCALES_DIR)) {
    const messages = JSON.parse(
      readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8')
    ) as Record<string, unknown>
    const missing = [...used].filter(key => !(key in messages) && !KNOWN_MISSING.has(key))
    expect(missing, `keys missing from ${locale}`).toEqual([])
  }
})
