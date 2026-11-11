import type { KeyboardEvent } from 'react'

/**
 * Whether a field's keydown is an Enter pressed in that field, the key that
 * submits it. The account switcher's controls act on the keydown of an Enter,
 * and the screen one opens focuses its field before that key comes up: a
 * field submits on the keydown, so the key's keyup, or its repeats while it
 * is held, submit nothing. Nor does the Enter that ends an input method's
 * composition.
 */
export function isEnterPressedInField(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.repeat && !event.nativeEvent.isComposing
}
