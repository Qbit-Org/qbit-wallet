import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ErrorCodes } from '@qbit/wallet-shared'
import { ApprovalService } from '../src/approval-service'

function makeApprovalData(overrides?: object) {
  return {
    state: 1,
    approvalComponent: 'SignTx',
    approvalType: 'transaction',
    params: { txid: 'abc123' },
    origin: 'https://example.com',
    ...overrides,
  }
}

// The id getApproval reports for the pending approval, as a window reads it.
function pendingId(service: ApprovalService) {
  const approval = service.getApproval()
  if (!approval) throw new Error('no approval is pending')
  return approval.id
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

// flush all pending microtasks and one macrotask tick
function flushAsync() {
  return new Promise((r) => setTimeout(r, 0))
}

describe('ApprovalService', () => {
  let service: ApprovalService

  beforeEach(() => {
    service = new ApprovalService()
    service.platformOpenWindow = vi.fn().mockResolvedValue(42)
    service.platformCloseWindow = vi.fn().mockResolvedValue(undefined)
    service.platformFocusWindow = vi.fn().mockResolvedValue(undefined)
  })

  // ── initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with no pending approval', () => {
      expect(service.approval).toBeNull()
    })

    it('starts unlocked', () => {
      expect(service.isLocked).toBe(false)
    })

    it('starts with approvalWindowId = 0', () => {
      expect(service.approvalWindowId).toBe(0)
    })
  })

  // ── lock / unlock ─────────────────────────────────────────────────────────

  describe('lock / unlock', () => {
    it('lock() sets isLocked to true', () => {
      service.lock()
      expect(service.isLocked).toBe(true)
    })

    it('unLock() sets isLocked to false', () => {
      service.lock()
      service.unLock()
      expect(service.isLocked).toBe(false)
    })
  })

  // ── getApproval ───────────────────────────────────────────────────────────

  describe('getApproval', () => {
    it('returns undefined when no approval is pending', () => {
      expect(service.getApproval()).toBeUndefined()
    })

    it('returns the approval data after requestApproval', () => {
      const data = makeApprovalData()
      service.requestApproval(data).catch(() => {})
      expect(service.getApproval()).toEqual({ id: expect.any(String), data })
    })
  })

  // ── requestApproval ───────────────────────────────────────────────────────

  describe('requestApproval', () => {
    it('opens a notification window', async () => {
      service.requestApproval(makeApprovalData()).catch(() => {})
      await flushAsync()
      expect(service.platformOpenWindow).toHaveBeenCalledTimes(1)
    })

    it('stores the pending approval', () => {
      const data = makeApprovalData()
      service.requestApproval(data).catch(() => {})
      expect(service.approval).not.toBeNull()
      expect(service.approval?.data).toEqual(data)
    })

    it('rejects a second approval request while one is pending', async () => {
      const first = makeApprovalData({ approvalType: 'first' })
      const second = makeApprovalData({ approvalType: 'second' })
      service.requestApproval(first).catch(() => {})
      await expect(service.requestApproval(second)).rejects.toMatchObject({
        message: 'Another approval request is already pending',
      })
      expect(service.getApproval()?.data).toMatchObject({ approvalType: 'first' })
    })

    it('focuses existing approval window before rejecting a second request', async () => {
      const first = makeApprovalData({ approvalType: 'first' })
      const second = makeApprovalData({ approvalType: 'second' })
      service.requestApproval(first).catch(() => {})
      await flushAsync()

      await expect(service.requestApproval(second)).rejects.toMatchObject({
        message: 'Another approval request is already pending',
      })
      expect(service.platformFocusWindow).toHaveBeenCalledWith(42)
    })

    it('still rejects second request when focus fails', async () => {
      const first = makeApprovalData({ approvalType: 'first' })
      const second = makeApprovalData({ approvalType: 'second' })
      service.platformFocusWindow = vi.fn().mockRejectedValue(new Error('focus failed'))
      service.requestApproval(first).catch(() => {})
      await flushAsync()

      await expect(service.requestApproval(second)).rejects.toMatchObject({
        message: 'Another approval request is already pending',
      })
      expect(service.getApproval()?.data).toMatchObject({ approvalType: 'first' })
    })

    it('does not try to focus when there is no window id', async () => {
      const first = makeApprovalData({ approvalType: 'first' })
      const second = makeApprovalData({ approvalType: 'second' })
      service.requestApproval(first).catch(() => {})
      service.approvalWindowId = 0

      await expect(service.requestApproval(second)).rejects.toMatchObject({
        message: 'Another approval request is already pending',
      })
      expect(service.platformFocusWindow).not.toHaveBeenCalled()
    })

    it('returns a Promise that resolves when resolveApproval is called', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await service.resolveApproval(pendingId(service), { result: 'ok' })
      await expect(promise).resolves.toEqual({ result: 'ok' })
    })

    it('returns a Promise that rejects when rejectApproval is called', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await service.rejectApproval(pendingId(service), 'User cancelled')
      await expect(promise).rejects.toMatchObject({ message: 'User cancelled' })
    })
  })

  // ── resolveApproval ───────────────────────────────────────────────────────

  describe('resolveApproval', () => {
    it('resolves with provided data', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await service.resolveApproval(pendingId(service), { sig: 'deadbeef' })
      await expect(promise).resolves.toEqual({ sig: 'deadbeef' })
    })

    it('clears the approval after resolving', async () => {
      service.requestApproval(makeApprovalData()).catch(() => {})
      await service.resolveApproval(pendingId(service), pendingId(service))
      expect(service.approval).toBeNull()
    })

    it('emits resolve event with the data', async () => {
      const listener = vi.fn()
      service.on('resolve', listener)
      service.requestApproval(makeApprovalData()).catch(() => {})
      await service.resolveApproval(pendingId(service), 'result')
      expect(listener).toHaveBeenCalledWith('result')
    })

    it('force-rejects when forceReject = true', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await service.resolveApproval(pendingId(service), undefined, true)
      await expect(promise).rejects.toMatchObject({ message: 'User Cancel' })
    })

    it('closes the notification window', async () => {
      service.requestApproval(makeApprovalData()).catch(() => {})
      await flushAsync() // wait for openNotification to assign approvalWindowId
      await service.resolveApproval(pendingId(service), pendingId(service))
      expect(service.platformCloseWindow).toHaveBeenCalled()
    })
  })

  // ── rejectApproval ────────────────────────────────────────────────────────

  describe('rejectApproval', () => {
    it('rejects with provided error message', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await service.rejectApproval(pendingId(service), 'something went wrong')
      await expect(promise).rejects.toMatchObject({ message: 'something went wrong' })
    })

    it('clears the approval after rejecting', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await service.rejectApproval(pendingId(service), 'err')
      expect(service.approval).toBeNull()
      await expect(promise).rejects.toBeDefined()
    })

    it('emits reject event with the error message', async () => {
      const listener = vi.fn()
      service.on('reject', listener)
      const promise = service.requestApproval(makeApprovalData())
      await service.rejectApproval(pendingId(service), 'cancelled')
      expect(listener).toHaveBeenCalledWith('cancelled')
      await expect(promise).rejects.toBeDefined()
    })

    it('does nothing when there is no pending approval', async () => {
      await expect(service.rejectApproval('no-op')).resolves.toBe(false)
    })

    it('keeps the window open when stay = true', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await flushAsync()
      const closeCallsBefore = (service.platformCloseWindow as ReturnType<typeof vi.fn>).mock.calls.length
      await service.rejectApproval(pendingId(service), 'err', true)
      await expect(promise).rejects.toBeDefined()
      expect((service.platformCloseWindow as ReturnType<typeof vi.fn>).mock.calls.length).toBe(closeCallsBefore)
    })

    it('does not close a retained window when no approval is pending', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await flushAsync()
      const settledId = pendingId(service)

      await service.rejectApproval(settledId, 'decode failed', true)
      await expect(promise).rejects.toBeDefined()
      expect(service.approval).toBeNull()
      expect(service.approvalWindowId).toBe(42)
      expect(service.platformCloseWindow).not.toHaveBeenCalled()

      await expect(service.rejectApproval(settledId)).resolves.toBe(false)

      expect(service.platformCloseWindow).not.toHaveBeenCalled()
      expect(service.approvalWindowId).toBe(42)
    })
  })

  // ── clear ─────────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('nullifies the approval', async () => {
      service.requestApproval(makeApprovalData()).catch(() => {})
      await service.clear()
      expect(service.approval).toBeNull()
    })

    it('closes the notification window and resets approvalWindowId', async () => {
      service.requestApproval(makeApprovalData()).catch(() => {})
      await flushAsync() // wait for openNotification to assign approvalWindowId
      await service.clear()
      expect(service.platformCloseWindow).toHaveBeenCalledWith(42)
      expect(service.approvalWindowId).toBe(0)
    })

    it('does not close window when stay = true', async () => {
      service.requestApproval(makeApprovalData()).catch(() => {})
      await flushAsync()
      const closeCallsBefore = (service.platformCloseWindow as ReturnType<typeof vi.fn>).mock.calls.length
      await service.clear(true)
      expect((service.platformCloseWindow as ReturnType<typeof vi.fn>).mock.calls.length).toBe(closeCallsBefore)
    })
  })

  // ── openNotification ──────────────────────────────────────────────────────

  describe('openNotification', () => {
    it('closes existing window before opening a new one', async () => {
      await service.openNotification()
      const firstId = service.approvalWindowId
      await service.openNotification()
      expect(service.platformCloseWindow).toHaveBeenCalledWith(firstId)
    })

    it('preserves a replacement approval when the retained window removal fires', async () => {
      service.platformOpenWindow = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(43)
      service.platformCloseWindow = vi.fn(async (windowId: number) => {
        await service.handleWindowRemoved(windowId)
      })

      const firstPromise = service.requestApproval(makeApprovalData({ approvalType: 'first' }))
      await flushAsync()
      await service.rejectApproval(pendingId(service), 'decode failed', true)
      await expect(firstPromise).rejects.toBeDefined()
      expect(service.approvalWindowId).toBe(42)

      const replacement = makeApprovalData({ approvalType: 'replacement' })
      const replacementPromise = service.requestApproval(replacement)
      await flushAsync()

      expect(service.platformCloseWindow).toHaveBeenCalledWith(42)
      expect(service.getApproval()?.data).toEqual(replacement)
      expect(service.approvalWindowId).toBe(43)

      await service.resolveApproval(pendingId(service), 'signed')
      await expect(replacementPromise).resolves.toBe('signed')
    })

    it('opens a replacement notification when the retained window is already gone', async () => {
      service.platformOpenWindow = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(43)

      const firstPromise = service.requestApproval(makeApprovalData({ approvalType: 'first' }))
      await flushAsync()
      await service.rejectApproval(pendingId(service), 'decode failed', true)
      await expect(firstPromise).rejects.toBeDefined()
      expect(service.approvalWindowId).toBe(42)

      service.platformCloseWindow = vi
        .fn()
        .mockRejectedValueOnce(new Error('No window with id: 42'))
        .mockResolvedValue(undefined)
      const replacement = makeApprovalData({ approvalType: 'replacement' })
      const replacementPromise = service.requestApproval(replacement)
      await flushAsync()

      expect(service.platformCloseWindow).toHaveBeenCalledWith(42)
      expect(service.platformOpenWindow).toHaveBeenCalledTimes(2)
      expect(service.getApproval()?.data).toEqual(replacement)
      expect(service.approvalWindowId).toBe(43)

      await service.resolveApproval(pendingId(service), 'signed')
      await expect(replacementPromise).resolves.toBe('signed')
    })

    it('assigns the returned window id to approvalWindowId', async () => {
      await service.openNotification()
      expect(service.approvalWindowId).toBe(42)
    })

    it('passes winProps to platformOpenWindow', async () => {
      const props = { width: 400, height: 600 }
      await service.openNotification(props)
      expect(service.platformOpenWindow).toHaveBeenCalledWith(props)
    })
  })

  describe('handleWindowRemoved', () => {
    it('rejects the active approval when its window is closed', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await flushAsync()

      await service.handleWindowRemoved(42)

      await expect(promise).rejects.toMatchObject({ code: 4001 })
      expect(service.approval).toBeNull()
      expect(service.approvalWindowId).toBe(0)
    })

    it('ignores unrelated window removals', async () => {
      service.requestApproval(makeApprovalData()).catch(() => {})
      await flushAsync()

      await service.handleWindowRemoved(99)

      expect(service.approval).not.toBeNull()
      expect(service.approvalWindowId).toBe(42)
    })

    it('ignores window removals when no approval is pending', async () => {
      await expect(service.handleWindowRemoved(42)).resolves.toBe(false)
    })

    it('clears a retained window id when its settled approval window is removed', async () => {
      const promise = service.requestApproval(makeApprovalData())
      await flushAsync()
      await service.rejectApproval(pendingId(service), 'decode failed', true)
      await expect(promise).rejects.toBeDefined()
      expect(service.approval).toBeNull()
      expect(service.approvalWindowId).toBe(42)

      await service.handleWindowRemoved(42)

      expect(service.approval).toBeNull()
      expect(service.approvalWindowId).toBe(0)
    })
  })

  // ── approval ids ──────────────────────────────────────────────────────────

  describe('approval ids', () => {
    // A window reads approval A, then A settles and B takes its place before
    // the window answers.
    async function replaceFirstApproval() {
      const first = service.requestApproval(makeApprovalData({ approvalType: 'first' }))
      await flushAsync()
      const firstId = pendingId(service)
      await service.rejectApproval(firstId, 'popup opened')
      await expect(first).rejects.toBeDefined()

      let secondSettled = false
      const second = service.requestApproval(makeApprovalData({ approvalType: 'second' }))
      second.then(
        () => (secondSettled = true),
        () => (secondSettled = true)
      )
      await flushAsync()
      return { firstId, secondId: pendingId(service), second, isSecondSettled: () => secondSettled }
    }

    it('gives every request its own random id', async () => {
      const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues')
      service.requestApproval(makeApprovalData()).catch(() => {})
      const firstId = pendingId(service)
      await service.resolveApproval(firstId)
      service.requestApproval(makeApprovalData()).catch(() => {})
      const secondId = pendingId(service)

      expect(firstId).toMatch(/^[0-9a-f]{32}$/)
      expect(secondId).toMatch(/^[0-9a-f]{32}$/)
      expect(secondId).not.toBe(firstId)
      expect(getRandomValues).toHaveBeenCalledTimes(2)
      getRandomValues.mockRestore()
    })

    it('reports the unlock request with its id', () => {
      service.requestApproval({ lock: true }).catch(() => {})
      expect(service.getApproval()).toEqual({ id: expect.any(String), data: { lock: true } })
    })

    it.each([
      ['resolve', (id: string) => service.resolveApproval(id, 'signed by a stale window')],
      ['force-reject', (id: string) => service.resolveApproval(id, undefined, true)],
      ['reject', (id: string) => service.rejectApproval(id, 'rejected by a stale window')],
    ])('a stale id cannot %s the approval that replaced it', async (_, settle) => {
      const { firstId, secondId, second, isSecondSettled } = await replaceFirstApproval()
      const onResolve = vi.fn()
      const onReject = vi.fn()
      service.on('resolve', onResolve)
      service.on('reject', onReject)
      const closeCalls = vi.mocked(service.platformCloseWindow).mock.calls.length

      await expect(settle(firstId)).resolves.toBe(false)
      await flushAsync()

      expect(isSecondSettled()).toBe(false)
      expect(service.getApproval()).toMatchObject({ id: secondId, data: { approvalType: 'second' } })
      expect(service.approvalWindowId).toBe(42)
      expect(service.platformCloseWindow).toHaveBeenCalledTimes(closeCalls)
      expect(onResolve).not.toHaveBeenCalled()
      expect(onReject).not.toHaveBeenCalled()

      await expect(service.resolveApproval(secondId, 'signed')).resolves.toBe(true)
      await expect(second).resolves.toBe('signed')
    })

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['unknown', '0'.repeat(32)],
      ['differently cased', 'UPPER'],
      ['numeric', 42],
      ['null', null],
      ['object', {}],
    ])('ignores a %s id', async (_, id) => {
      let settled = false
      service
        .requestApproval(makeApprovalData())
        .then(
          () => (settled = true),
          () => (settled = true)
        )
      await flushAsync()
      const pending = pendingId(service)
      const badId = (id === 'UPPER' ? pending.toUpperCase() : id) as string

      await expect(service.resolveApproval(badId)).resolves.toBe(false)
      await expect(service.resolveApproval(badId, undefined, true)).resolves.toBe(false)
      await expect(service.rejectApproval(badId)).resolves.toBe(false)
      await flushAsync()

      expect(settled).toBe(false)
      expect(service.getApproval()?.id).toBe(pending)
      expect(service.platformCloseWindow).not.toHaveBeenCalled()
    })

    it('settles an approval once when its window answers twice', async () => {
      const promise = service.requestApproval(makeApprovalData())
      const id = pendingId(service)
      const onResolve = vi.fn()
      service.on('resolve', onResolve)

      await expect(service.resolveApproval(id, 'first answer')).resolves.toBe(true)
      await expect(service.resolveApproval(id, 'second answer')).resolves.toBe(false)
      await expect(service.rejectApproval(id, 'late cancel')).resolves.toBe(false)

      await expect(promise).resolves.toBe('first answer')
      expect(onResolve).toHaveBeenCalledOnce()
    })

    it('a removed window rejects only the approval it was opened for', async () => {
      const opens = [deferred<number>(), deferred<number>()]
      service.platformOpenWindow = vi
        .fn()
        .mockReturnValueOnce(opens[0].promise)
        .mockReturnValueOnce(opens[1].promise)

      const first = service.requestApproval(makeApprovalData({ approvalType: 'first' }))
      await service.rejectApproval(pendingId(service), 'popup opened')
      await expect(first).rejects.toBeDefined()
      const second = service.requestApproval(makeApprovalData({ approvalType: 'second' }))
      const secondId = pendingId(service)

      // The second approval's window opens before the first one's does.
      opens[1].resolve(43)
      await flushAsync()
      opens[0].resolve(42)
      await flushAsync()

      expect(service.platformCloseWindow).toHaveBeenCalledWith(42)
      expect(service.approvalWindowId).toBe(43)
      await expect(service.handleWindowRemoved(42)).resolves.toBe(false)
      expect(service.getApproval()?.id).toBe(secondId)

      await expect(service.handleWindowRemoved(43)).resolves.toBe(true)
      await expect(second).rejects.toMatchObject({ code: 4001 })
      expect(service.approval).toBeNull()
    })

    it('binds a window opened without an id to the pending approval', async () => {
      service.platformOpenWindow = vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(43)
      const promise = service.requestApproval(makeApprovalData())
      await flushAsync()

      await service.openNotification()
      expect(service.approvalWindowId).toBe(43)

      await expect(service.handleWindowRemoved(43)).resolves.toBe(true)
      await expect(promise).rejects.toMatchObject({ code: 4001 })
    })

    it('rejects an approval whose window was closed before it finished opening', async () => {
      const open = deferred<number>()
      service.platformOpenWindow = vi.fn().mockReturnValueOnce(open.promise)
      const promise = service.requestApproval(makeApprovalData())
      await flushAsync()

      // The browser reports the removal before windows.create has answered.
      await expect(service.handleWindowRemoved(42)).resolves.toBe(false)
      open.resolve(42)

      await expect(promise).rejects.toMatchObject({ code: 4001 })
      expect(service.approval).toBeNull()
      expect(service.approvalWindowId).toBe(0)
      expect(service.platformCloseWindow).not.toHaveBeenCalled()
    })

    it('keeps an approval whose window opens while an unrelated window closes', async () => {
      const open = deferred<number>()
      service.platformOpenWindow = vi.fn().mockReturnValueOnce(open.promise)
      const promise = service.requestApproval(makeApprovalData())
      const id = pendingId(service)

      await service.handleWindowRemoved(99)
      open.resolve(42)
      await flushAsync()

      expect(service.getApproval()?.id).toBe(id)
      expect(service.approvalWindowId).toBe(42)
      await expect(service.handleWindowRemoved(42)).resolves.toBe(true)
      await expect(promise).rejects.toMatchObject({ code: 4001 })
    })

    it('rejects an approval whose window fails to open, so the next request can open', async () => {
      service.platformOpenWindow = vi
        .fn()
        .mockRejectedValueOnce(new Error('No current window'))
        .mockResolvedValueOnce(43)
      const promise = service.requestApproval(makeApprovalData())

      await expect(promise).rejects.toMatchObject({
        code: ErrorCodes.UNKNOWN,
        message: 'Approval window failed to open',
      })
      expect(service.approval).toBeNull()

      service.requestApproval(makeApprovalData()).catch(() => {})
      await flushAsync()
      expect(service.approvalWindowId).toBe(43)
    })

    it('still reports a failed open when no approval is pending', async () => {
      service.platformOpenWindow = vi.fn().mockRejectedValueOnce(new Error('No current window'))
      await expect(service.openNotification()).rejects.toThrow('No current window')
    })

    it('closes a window that finishes opening after its approval settled', async () => {
      const open = deferred<number>()
      service.platformOpenWindow = vi.fn().mockReturnValueOnce(open.promise)

      const promise = service.requestApproval(makeApprovalData())
      await service.rejectApproval(pendingId(service), 'popup opened')
      await expect(promise).rejects.toBeDefined()
      open.resolve(42)
      await flushAsync()

      expect(service.platformCloseWindow).toHaveBeenCalledWith(42)
      expect(service.approvalWindowId).toBe(0)
    })
  })

  // ── EventEmitter integration ──────────────────────────────────────────────

  describe('EventEmitter', () => {
    it('supports multiple listeners on the same event', async () => {
      const a = vi.fn()
      const b = vi.fn()
      service.on('resolve', a)
      service.on('resolve', b)
      service.requestApproval(makeApprovalData()).catch(() => {})
      await service.resolveApproval(pendingId(service), 'data')
      expect(a).toHaveBeenCalledWith('data')
      expect(b).toHaveBeenCalledWith('data')
    })

    it('once() listener fires only once', async () => {
      const listener = vi.fn()
      service.once('resolve', listener)
      service.requestApproval(makeApprovalData()).catch(() => {})
      await service.resolveApproval(pendingId(service), pendingId(service))
      service.requestApproval(makeApprovalData()).catch(() => {})
      await service.resolveApproval(pendingId(service), pendingId(service))
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
})
