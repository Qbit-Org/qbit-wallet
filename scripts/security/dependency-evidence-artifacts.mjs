import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

function isRegularFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Stage every artifact next to its target before replacing any of them, so a
// failure while producing one output leaves the previously committed pair
// untouched instead of a half-regenerated audit/inventory set. Replacement
// then moves each existing target aside before renaming its staged content
// into place, and a failing rename restores every target already replaced,
// so the pair is complete or unchanged even when replacement itself fails.
export function writeGeneratedEvidence(repoRoot, artifacts) {
  const staged = []
  try {
    for (const { file, content } of artifacts) {
      const target = join(repoRoot, file)
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, content)
      staged.push({ temporary, target, backup: `${target}.${process.pid}.bak` })
    }
  } catch (error) {
    for (const { temporary } of staged) rmSync(temporary, { force: true })
    throw error
  }

  const displaced = []
  const written = []
  try {
    for (const { temporary, target, backup } of staged) {
      if (isRegularFile(target)) {
        renameSync(target, backup)
        displaced.push({ target, backup })
      }
      renameSync(temporary, target)
      written.push(target)
    }
  } catch (error) {
    const restorable = new Set(displaced.map(({ target }) => target))
    for (const { temporary } of staged) rmSync(temporary, { force: true })
    for (const target of written) {
      if (!restorable.has(target)) rmSync(target, { force: true })
    }
    for (const { target, backup } of displaced) renameSync(backup, target)
    throw error
  }
  for (const { backup } of displaced) rmSync(backup, { force: true })
}
