import { describe, expect, it } from 'vitest'

import { isQbitAccountOutput } from '../src/utils'

const script = `5220${'aa'.repeat(32)}`
const other = `5220${'bb'.repeat(32)}`

describe('isQbitAccountOutput', () => {
  it("takes an output carrying the account's scriptPubKey, in any case", () => {
    expect(isQbitAccountOutput({ scriptPk: script }, script)).toBe(true)
    expect(isQbitAccountOutput({ scriptPk: script.toUpperCase() }, script)).toBe(true)
  })

  it('refuses another script, and an output with no scriptPubKey or an empty one', () => {
    expect(isQbitAccountOutput({ scriptPk: other }, script)).toBe(false)
    expect(isQbitAccountOutput({ scriptPk: '' }, script)).toBe(false)
    expect(isQbitAccountOutput({}, script)).toBe(false)
    expect(isQbitAccountOutput({ scriptPk: null }, script)).toBe(false)
  })

  it('without a script on record, still needs the output to carry one', () => {
    expect(isQbitAccountOutput({ scriptPk: other }, undefined)).toBe(true)
    expect(isQbitAccountOutput({ scriptPk: '' }, undefined)).toBe(false)
    expect(isQbitAccountOutput({}, undefined)).toBe(false)
  })
})
