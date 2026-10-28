import { describe, expect, it } from 'vitest'

import { getPasswordStrengthWord } from '../src/utils/password-utils'

const translate = (key: string) => key

describe('password strength foreground colors', () => {
  it('uses readable semantic colors for weak and average states', () => {
    expect(getPasswordStrengthWord('short', translate).color).toBe('#C92B40')
    expect(getPasswordStrengthWord('Strongish', translate).color).toBe('#B54708')
  })
})
