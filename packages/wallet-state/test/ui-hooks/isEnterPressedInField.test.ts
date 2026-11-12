import type { KeyboardEvent } from 'react'
import { describe, expect, it } from 'vitest'

import { isEnterPressedInField } from '../../src'

/** A keydown in a field, as the field hands it on. */
function keyDown(key: string, { repeat = false, isComposing = false } = {}) {
  return { key, repeat, nativeEvent: { isComposing } } as unknown as KeyboardEvent
}

describe('isEnterPressedInField', () => {
  it('is true for an Enter pressed in the field', () => {
    expect(isEnterPressedInField(keyDown('Enter'))).toBe(true)
  })

  it.each([
    ['a held Enter repeating', keyDown('Enter', { repeat: true })],
    ['the Enter that ends an input method composition', keyDown('Enter', { isComposing: true })],
    ['another key', keyDown('a')],
    ['the space bar', keyDown(' ')],
  ])('is false for %s', (_which, event) => {
    expect(isEnterPressedInField(event)).toBe(false)
  })
})
