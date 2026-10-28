import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bgEventBus } from '../src/utils/eventBus'

describe('bgEventBus', () => {
  beforeEach(() => {
    ;(bgEventBus as any).events = {}
  })

  it('addEventListener + emit passes payload', () => {
    const listener = vi.fn()

    bgEventBus.addEventListener('update', listener)
    bgEventBus.emit('update', { value: 1 })

    expect(listener).toHaveBeenCalledWith({ value: 1 })
  })

  it('once listener is called only one time', () => {
    const listener = vi.fn()

    bgEventBus.once('ready', listener)
    bgEventBus.emit('ready', 'first')
    bgEventBus.emit('ready', 'second')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('first')
  })

  it('removeEventListener removes a specific handler', () => {
    const a = vi.fn()
    const b = vi.fn()

    bgEventBus.addEventListener('tick', a)
    bgEventBus.addEventListener('tick', b)
    bgEventBus.removeEventListener('tick', a)

    bgEventBus.emit('tick', 1)

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith(1)
  })

  it('removeAllEventListeners clears listeners for event type', () => {
    const listener = vi.fn()

    bgEventBus.addEventListener('x', listener)
    bgEventBus.removeAllEventListeners('x')
    bgEventBus.emit('x', 'data')

    expect(listener).not.toHaveBeenCalled()
  })
})
