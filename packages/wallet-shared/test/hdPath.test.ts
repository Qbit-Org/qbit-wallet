import { describe, expect, it } from 'vitest'

import { getAccountDerivationPath } from '../src/utils/hdPath'

describe('getAccountDerivationPath', () => {
  it('appends account index in standard mode', () => {
    expect(getAccountDerivationPath("m/84'/0'/0'/0", 2)).toBe("m/84'/0'/0'/0/2")
  })

  it('replaces account segment in account-index derivation mode', () => {
    expect(getAccountDerivationPath("m/84'/0'/0'/0", 2, true)).toBe("m/84'/0'/2'/0/0")
  })

  it('throws when account-index derivation receives invalid path', () => {
    expect(() => getAccountDerivationPath("m/84'/0'", 1, true)).toThrow(
      'Invalid hdPath for account-index derivation'
    )
  })
})
