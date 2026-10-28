import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bgEventBus } from '../src/utils/eventBus'

describe('bgEventBus', () => {
  beforeEach(() => {
    ;(bgEventBus as any).events = {}
  })

  it('emits payload to all listeners', () => {
    const a = vi.fn()
    const b = vi.fn()

    bgEventBus.addEventListener('wallet:updated', a)
    bgEventBus.addEventListener('wallet:updated', b)
    bgEventBus.emit('wallet:updated', { id: 1 })

    expect(a).toHaveBeenCalledWith({ id: 1 })
    expect(b).toHaveBeenCalledWith({ id: 1 })
  })

  it('once listener is removed after first call', () => {
    const listener = vi.fn()

    bgEventBus.once('ready', listener)
    bgEventBus.emit('ready', 1)
    bgEventBus.emit('ready', 2)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(1)
  })

  it('removeEventListener and removeAllEventListeners work as expected', () => {
    const a = vi.fn()
    const b = vi.fn()

    bgEventBus.addEventListener('tick', a)
    bgEventBus.addEventListener('tick', b)
    bgEventBus.removeEventListener('tick', a)

    bgEventBus.emit('tick', 'x')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith('x')

    bgEventBus.removeAllEventListeners('tick')
    bgEventBus.emit('tick', 'y')
    expect(b).toHaveBeenCalledTimes(1)
  })
})
