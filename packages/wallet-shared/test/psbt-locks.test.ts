import { describe, expect, it } from 'vitest'

import { SEQUENCE_FINAL, isPsbtLocktimeEnforced, psbtRelativeLocks } from '../src/utils/psbt-locks'
import * as shared from '../src'

/** Inputs with these sequences, in order. */
function inputs(...sequences: (number | undefined)[]) {
  return sequences.map(sequence => (sequence === undefined ? {} : { sequence }))
}

describe('isPsbtLocktimeEnforced', () => {
  it('holds a transaction back unless nLockTime is 0 or every input is final', () => {
    expect(isPsbtLocktimeEnforced(900_000, inputs(0xfffffffd))).toBe(true)
    expect(isPsbtLocktimeEnforced(900_000, inputs(SEQUENCE_FINAL, 0xfffffffe))).toBe(true)
    expect(isPsbtLocktimeEnforced(1_767_225_600, inputs(0x00000090))).toBe(true)
    expect(isPsbtLocktimeEnforced(0, inputs(0xfffffffd))).toBe(false)
    expect(isPsbtLocktimeEnforced(900_000, inputs(SEQUENCE_FINAL, SEQUENCE_FINAL))).toBe(false)
  })

  it('takes an input whose sequence is unknown as not final', () => {
    expect(isPsbtLocktimeEnforced(900_000, inputs(SEQUENCE_FINAL, undefined))).toBe(true)
  })
})

describe('psbtRelativeLocks', () => {
  it('reads a block lock and a time lock in 512-second units, for each input that sets one', () => {
    expect(psbtRelativeLocks(2, inputs(0x00000090, 0xfffffffd, 0x00400090))).toEqual([
      { input: 0, type: 'blocks', value: 144 },
      { input: 2, type: 'time', value: 144 * 512 },
    ])
  })

  it('reads only the type bit and the low 16 bits, whatever the bits a lock leaves unused', () => {
    expect(psbtRelativeLocks(2, inputs(0x7fbf0001, 0x7fff0002))).toEqual([
      { input: 0, type: 'blocks', value: 1 },
      { input: 1, type: 'time', value: 1024 },
    ])
    expect(psbtRelativeLocks(2, inputs(0x0000ffff, 0x0040ffff))).toEqual([
      { input: 0, type: 'blocks', value: 0xffff },
      { input: 1, type: 'time', value: 0xffff * 512 },
    ])
  })

  it('finds none when the disable bit is set, the lock is 0 or the sequence is unknown', () => {
    const final = inputs(SEQUENCE_FINAL, 0xfffffffe, 0xfffffffd)
    const disabled = inputs(0x80000090, 0x80400090)
    const zero = inputs(0x00000000, 0x00400000)
    expect(psbtRelativeLocks(2, [...final, ...disabled, ...zero, ...inputs(undefined)])).toEqual([])
  })

  it('enforces them from version 2, read as a uint32', () => {
    for (const version of [0, 1]) {
      expect(psbtRelativeLocks(version, inputs(0x00000090)), `version ${version}`).toEqual([])
    }
    for (const version of [2, 3, 0x7fffffff, 0x80000000, 0xffffffff, -1]) {
      expect(psbtRelativeLocks(version, inputs(0x00000090)), `version ${version}`).toEqual([
        { input: 0, type: 'blocks', value: 144 },
      ])
    }
  })

  it('is exported from the package', () => {
    expect(shared.psbtRelativeLocks).toBe(psbtRelativeLocks)
    expect(shared.isPsbtLocktimeEnforced).toBe(isPsbtLocktimeEnforced)
    expect(shared.SEQUENCE_FINAL).toBe(0xffffffff)
  })
})
