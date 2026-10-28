import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ErrorCodes,
  QBIT_REGTEST_GENESIS_HASH,
  REGTEST_ACCESS_ACK_VERSION,
} from '@qbit/wallet-shared'
import {
  RegtestAccessService,
  type RegtestAccessAckStore,
  type RegtestAccessAdapter,
} from '../src/services/regtestAccess'

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
}

function healthyFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/block-height/0')) return textResponse(QBIT_REGTEST_GENESIS_HASH)
    if (url.endsWith('/blocks/tip/height')) return textResponse('3')
    throw new TypeError(`unexpected ${url}`)
  })
}

function createAdapter(overrides: Partial<RegtestAccessAdapter> & { optional?: boolean } = {}) {
  const listeners: Array<() => void> = []
  const adapter = {
    isOptionalPermission: vi.fn(() => overrides.optional ?? true),
    containsPermission: vi.fn(async () => false),
    onPermissionRemoved: vi.fn((listener: () => void) => {
      listeners.push(listener)
    }),
    ...overrides,
  }
  return { adapter, fireRemoved: () => listeners.forEach(listener => listener()) }
}

function createAckStore(initial?: string): RegtestAccessAckStore & { value: string | undefined } {
  const store = {
    value: initial,
    get: () => store.value,
    set: vi.fn(async (ack: string | undefined) => {
      store.value = ack
    }),
  }
  return store
}

describe('RegtestAccessService', () => {
  let service: RegtestAccessService

  beforeEach(() => {
    service = new RegtestAccessService()
  })

  it('is unsupported (and therefore not a gate) until a platform adapter is installed', async () => {
    expect(service.isSupported()).toBe(false)
    expect(service.getStatus()).toMatchObject({ state: 'locked', supported: false, gated: false })
    await expect(service.assertAvailable()).resolves.toBeUndefined()
    await expect(service.refresh({ verify: true })).resolves.toMatchObject({ supported: false })
    await expect(service.acknowledge()).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
  })

  it('starts locked and reports whether the build gates regtest behind the optional permission', () => {
    const { adapter } = createAdapter({ optional: true })
    service.init({ adapter, ackStore: createAckStore() })
    expect(service.getStatus()).toEqual({
      state: 'locked',
      gated: true,
      permission: false,
      acknowledged: false,
      supported: true,
    })
    expect(adapter.onPermissionRemoved).toHaveBeenCalledTimes(1)
  })

  it('stays locked without the browser permission even when an acknowledgement is persisted', async () => {
    const { adapter } = createAdapter()
    const fetch = healthyFetch()
    service.init({ adapter, ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION), fetch })

    const status = await service.refresh({ verify: true })
    expect(status).toMatchObject({
      state: 'locked',
      permission: false,
      acknowledged: true,
      reason: 'permission_missing',
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(service.assertAvailable()).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
  })

  it('stays locked with the permission but without a current acknowledgement', async () => {
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    const fetch = healthyFetch()
    service.init({ adapter, ackStore: createAckStore('regtest_access_ack_v0'), fetch })

    await expect(service.refresh({ verify: true })).resolves.toMatchObject({
      state: 'locked',
      permission: true,
      acknowledged: false,
      reason: 'acknowledgement_missing',
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(service.assertAvailable()).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
  })

  it('becomes available only after permission, acknowledgement and identity verification succeed', async () => {
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    const fetch = healthyFetch()
    const changed = vi.fn()
    service.init({
      adapter,
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
      fetch,
      now: () => 99,
    })
    service.on('changed', changed)

    // A cheap status read never probes and reports the verification as pending.
    await expect(service.refresh({ verify: false })).resolves.toMatchObject({ state: 'checking' })
    expect(fetch).not.toHaveBeenCalled()

    const status = await service.refresh({ verify: true })
    expect(status).toEqual({
      state: 'available',
      gated: true,
      permission: true,
      acknowledged: true,
      supported: true,
      verifiedAt: 99,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls.map(([status]) => status.state)).toEqual(['checking', 'available'])
    await expect(service.assertAvailable()).resolves.toBeUndefined()
  })

  it('reports an unreachable or unexpected service without unlocking access', async () => {
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    let mode: 'down' | 'wrong' = 'down'
    const fetch = vi.fn(async (url: string) => {
      if (mode === 'down') throw new TypeError('ECONNREFUSED')
      if (url.endsWith('/block-height/0')) return textResponse('0'.repeat(64))
      return textResponse('1')
    })
    service.init({ adapter, ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION), fetch })

    await expect(service.refresh({ verify: true })).resolves.toMatchObject({
      state: 'unreachable',
      reason: 'network_error',
    })
    await expect(service.assertAvailable()).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_SERVICE_UNREACHABLE,
    })

    mode = 'wrong'
    await expect(service.refresh({ verify: true })).resolves.toMatchObject({
      state: 'unexpected_service',
      reason: 'genesis_mismatch',
    })
    await expect(service.assertAvailable()).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_SERVICE_UNEXPECTED,
    })
    // A non-probing status read keeps the last verification verdict.
    await expect(service.refresh({ verify: false })).resolves.toMatchObject({
      state: 'unexpected_service',
    })
  })

  it('records the acknowledgement only after the browser confirms the grant', async () => {
    const contains = vi.fn(async () => false)
    const { adapter } = createAdapter({ containsPermission: contains })
    const ackStore = createAckStore()
    const fetch = healthyFetch()
    service.init({ adapter, ackStore, fetch })

    // Spoofed UI: nothing was granted, so consent must not be stored.
    await expect(service.acknowledge()).resolves.toMatchObject({
      state: 'locked',
      permission: false,
      reason: 'permission_missing',
    })
    expect(ackStore.set).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    contains.mockResolvedValue(true)
    await expect(service.acknowledge()).resolves.toMatchObject({ state: 'available' })
    expect(ackStore.value).toBe(REGTEST_ACCESS_ACK_VERSION)
  })

  it('does not require an acknowledgement when the loopback permission is required by the manifest', async () => {
    const { adapter } = createAdapter({
      optional: false,
      containsPermission: vi.fn(async () => true),
    })
    const ackStore = createAckStore()
    service.init({ adapter, ackStore, fetch: healthyFetch() })

    await expect(service.refresh({ verify: true })).resolves.toMatchObject({
      state: 'available',
      gated: false,
      acknowledged: true,
    })
    expect(ackStore.set).not.toHaveBeenCalled()
  })

  it('locks immediately on a permission removal event and notifies listeners', async () => {
    const contains = vi.fn(async () => true)
    const { adapter, fireRemoved } = createAdapter({ containsPermission: contains })
    service.init({
      adapter,
      ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION),
      fetch: healthyFetch(),
    })
    const removed = vi.fn()
    service.on('permissionRemoved', removed)
    await service.refresh({ verify: true })
    expect(service.getStatus().state).toBe('available')

    contains.mockResolvedValue(false)
    fireRemoved()
    await waitFor(() => expect(removed).toHaveBeenCalledTimes(1))
    expect(service.getStatus()).toMatchObject({
      state: 'locked',
      permission: false,
      reason: 'permission_missing',
    })
    // The event payload is not trusted: an unrelated removal re-checks contains().
    contains.mockResolvedValue(true)
    removed.mockClear()
    fireRemoved()
    await waitFor(() =>
      expect(service.getStatus()).toMatchObject({ state: 'checking', permission: true })
    )
    expect(contains).toHaveBeenCalledTimes(4)
    expect(removed).not.toHaveBeenCalled()
  })

  it('keeps an available capability available when an unrelated permission is removed', async () => {
    const contains = vi.fn(async () => true)
    const { adapter, fireRemoved } = createAdapter({ containsPermission: contains })
    const fetch = healthyFetch()
    service.init({ adapter, ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION), fetch })
    const removed = vi.fn()
    service.on('permissionRemoved', removed)
    await service.refresh({ verify: true })
    expect(service.getStatus().state).toBe('available')
    const probesBefore = fetch.mock.calls.length

    // Some other origin's permission was revoked. contains() still reports the
    // loopback grant, so nothing about this capability changed: it must not
    // drop into `checking`, where no verification is scheduled to leave it.
    fireRemoved()
    await waitFor(() => expect(contains).toHaveBeenCalledTimes(3))

    expect(service.getStatus()).toMatchObject({ state: 'available', permission: true })
    expect(removed).not.toHaveBeenCalled()
    // No re-probe either: an unrelated removal is not evidence about the service.
    expect(fetch.mock.calls.length).toBe(probesBefore)
  })

  it('discards a verification that completes after the permission was withdrawn', async () => {
    let releaseIdentity!: () => void
    const identityGate = new Promise<void>(resolve => {
      releaseIdentity = resolve
    })
    const contains = vi.fn(async () => true)
    const { adapter, fireRemoved } = createAdapter({ containsPermission: contains })
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/block-height/0')) {
        await identityGate
        return textResponse(QBIT_REGTEST_GENESIS_HASH)
      }
      return textResponse('1')
    })
    service.init({ adapter, ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION), fetch })

    const pending = service.assertAvailable()
    await waitFor(() => expect(service.getStatus().state).toBe('checking'))
    contains.mockResolvedValue(false)
    fireRemoved()
    await waitFor(() => expect(service.getStatus().state).toBe('locked'))
    releaseIdentity()

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.REGTEST_ACCESS_LOCKED })
    expect(service.getStatus()).toMatchObject({ state: 'locked', permission: false })
  })

  it('re-reads the permission after the probe so a mid-probe revocation cannot unlock access', async () => {
    const contains = vi.fn(async () => true)
    const { adapter } = createAdapter({ containsPermission: contains })
    const fetch = vi.fn(async (url: string) => {
      contains.mockResolvedValue(false)
      return textResponse(url.endsWith('/block-height/0') ? QBIT_REGTEST_GENESIS_HASH : '1')
    })
    service.init({ adapter, ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION), fetch })

    await expect(service.refresh({ verify: true })).resolves.toMatchObject({
      state: 'locked',
      permission: false,
      reason: 'permission_missing',
    })
  })

  it('deduplicates concurrent verifications', async () => {
    const { adapter } = createAdapter({ containsPermission: vi.fn(async () => true) })
    const fetch = healthyFetch()
    service.init({ adapter, ackStore: createAckStore(REGTEST_ACCESS_ACK_VERSION), fetch })

    const [a, b] = await Promise.all([
      service.refresh({ verify: true }),
      service.refresh({ verify: true }),
    ])
    expect(a.state).toBe('available')
    expect(b.state).toBe('available')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('clearing consent locks the capability while the browser grant stays in place', async () => {
    const contains = vi.fn(async () => true)
    const { adapter } = createAdapter({ containsPermission: contains })
    const ackStore = createAckStore(REGTEST_ACCESS_ACK_VERSION)
    service.init({ adapter, ackStore, fetch: healthyFetch() })
    await service.refresh({ verify: true })
    expect(service.getStatus().state).toBe('available')

    await service.clearAcknowledgement()
    expect(ackStore.value).toBeUndefined()
    // The permission is untouched (Chrome will not remove it through the
    // API for this manifest); the missing acknowledgement alone locks access
    // and a fresh read still says so.
    expect(service.getStatus()).toMatchObject({
      state: 'locked',
      permission: true,
      acknowledged: false,
      reason: 'acknowledgement_missing',
    })
    await expect(service.refresh({ verify: true })).resolves.toMatchObject({
      state: 'locked',
      permission: true,
      reason: 'acknowledgement_missing',
    })
    await expect(service.assertAvailable()).rejects.toMatchObject({
      code: ErrorCodes.REGTEST_ACCESS_LOCKED,
    })
  })
})
