/**
 * Background-owned capability that decides whether the wallet may enter the
 * local Qbit regtest network.
 *
 * Three independent facts feed the state:
 *   1. the live browser host permission for the fixed loopback origin, read
 *      through an injected adapter (`chrome.permissions` never leaks into
 *      shared wallet code and the UI cannot substitute a "granted" flag),
 *   2. the versioned in-app acknowledgement kept in extension-wide storage,
 *   3. the latest bounded identity verification of the service itself.
 *
 * None of them is persisted as an "enabled" boolean: the permission is always
 * re-read from the browser and the service check is transient.
 */

import { EventEmitter } from 'eventemitter3'

import {
  ErrorCodes,
  REGTEST_ACCESS_ACK_VERSION,
  WalletError,
  type RegtestAccessReason,
  type RegtestAccessState,
  type RegtestAccessStatus,
} from '@qbit/wallet-shared'

import {
  verifyRegtestService,
  type RegtestFetch,
  type RegtestServiceVerificationOptions,
} from '../utils/regtest-service-verification'

/** Platform boundary for the optional loopback host permission. */
export interface RegtestAccessAdapter {
  /**
   * True when the running manifest declares the loopback origin as an
   * optional (runtime-requested) permission. Builds that ship it as a
   * required permission (E2E, local development) are not gated by the
   * acknowledgement flow.
   */
  isOptionalPermission(): boolean
  /** `chrome.permissions.contains()` for the exact loopback origin. */
  containsPermission(): Promise<boolean>
  /** Subscribe to `chrome.permissions.onRemoved`; the service re-checks `contains()`. */
  onPermissionRemoved(listener: () => void): void
}

/** Extension-wide persistence of the acknowledgement version. */
export interface RegtestAccessAckStore {
  get(): string | undefined
  set(ack: string | undefined): Promise<void>
}

export interface RegtestAccessServiceConfig {
  adapter: RegtestAccessAdapter
  ackStore: RegtestAccessAckStore
  logger?: { warn(message: string, ...details: unknown[]): void }
  fetch?: RegtestFetch
  now?: () => number
  verification?: Pick<RegtestServiceVerificationOptions, 'timeoutMs' | 'maxBodyBytes'>
}

export interface RegtestAccessEvents {
  changed: (status: RegtestAccessStatus) => void
  permissionRemoved: () => void
}

interface VerificationMemo {
  state: Exclude<RegtestAccessState, 'locked' | 'checking'>
  reason?: RegtestAccessReason
  verifiedAt?: number
}

const UNSUPPORTED_STATUS: RegtestAccessStatus = Object.freeze({
  state: 'locked',
  gated: false,
  permission: false,
  acknowledged: false,
  supported: false,
})

export function regtestAccessError(status: RegtestAccessStatus): WalletError {
  switch (status.state) {
    case 'unreachable':
      return new WalletError(ErrorCodes.REGTEST_SERVICE_UNREACHABLE)
    case 'unexpected_service':
      return new WalletError(ErrorCodes.REGTEST_SERVICE_UNEXPECTED)
    default:
      return new WalletError(ErrorCodes.REGTEST_ACCESS_LOCKED)
  }
}

export class RegtestAccessService extends EventEmitter<RegtestAccessEvents> {
  private adapter: RegtestAccessAdapter | undefined
  private ackStore: RegtestAccessAckStore | undefined
  private logger: RegtestAccessServiceConfig['logger']
  private fetchImpl: RegtestFetch | undefined
  private now: () => number = Date.now
  private verificationOptions: RegtestAccessServiceConfig['verification']
  private status: RegtestAccessStatus = { ...UNSUPPORTED_STATUS }
  private lastVerification: VerificationMemo | undefined
  private inflightVerification: Promise<RegtestAccessStatus> | undefined
  /** Bumped whenever consent or permission is withdrawn so stale probes cannot re-open access. */
  private generation = 0

  init(config: RegtestAccessServiceConfig): void {
    this.adapter = config.adapter
    this.ackStore = config.ackStore
    this.logger = config.logger
    this.fetchImpl = config.fetch
    this.now = config.now ?? Date.now
    this.verificationOptions = config.verification
    this.lastVerification = undefined
    this.inflightVerification = undefined
    this.generation += 1
    this.setStatus({
      state: 'locked',
      gated: config.adapter.isOptionalPermission(),
      permission: false,
      acknowledged: false,
      supported: true,
    })
    config.adapter.onPermissionRemoved(() => {
      void this.handlePermissionRemoved()
    })
  }

  /** False on platforms without a permission adapter; callers keep the pre-existing behaviour there. */
  isSupported(): boolean {
    return this.adapter !== undefined
  }

  getStatus(): RegtestAccessStatus {
    return { ...this.status }
  }

  private isAcknowledged(): boolean {
    if (!this.status.gated) return true
    return this.ackStore?.get() === REGTEST_ACCESS_ACK_VERSION
  }

  /**
   * Re-read the browser permission and acknowledgement. With `verify`, also
   * run the bounded service identity check (deduplicated while in flight).
   */
  async refresh(options: { verify: boolean }): Promise<RegtestAccessStatus> {
    const adapter = this.adapter
    if (!adapter) {
      return this.getStatus()
    }

    const permission = await adapter.containsPermission()
    const acknowledged = this.isAcknowledged()
    if (!permission || !acknowledged) {
      this.lastVerification = undefined
      this.setStatus({
        state: 'locked',
        gated: this.status.gated,
        permission,
        acknowledged,
        supported: true,
        reason: permission ? 'acknowledgement_missing' : 'permission_missing',
      })
      return this.getStatus()
    }

    if (!options.verify) {
      this.setStatus(this.composeVerified(permission, acknowledged, this.lastVerification))
      return this.getStatus()
    }

    if (this.inflightVerification) {
      return this.inflightVerification
    }
    const run = this.runVerification(permission, acknowledged).finally(() => {
      this.inflightVerification = undefined
    })
    this.inflightVerification = run
    return run
  }

  private async runVerification(
    permission: boolean,
    acknowledged: boolean
  ): Promise<RegtestAccessStatus> {
    const generation = this.generation
    this.setStatus({
      state: 'checking',
      gated: this.status.gated,
      permission,
      acknowledged,
      supported: true,
    })

    const result = await verifyRegtestService({
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      now: this.now,
      ...(this.verificationOptions ?? {}),
    })

    if (generation !== this.generation) {
      // Consent or permission was withdrawn while the probe ran.
      return this.getStatus()
    }

    // The permission can be revoked while the probe is in flight; re-read it
    // rather than trusting the value captured before the check started.
    const stillPermitted = await this.adapter!.containsPermission()
    if (!stillPermitted || generation !== this.generation) {
      this.lastVerification = undefined
      this.setStatus({
        state: 'locked',
        gated: this.status.gated,
        permission: false,
        acknowledged,
        supported: true,
        reason: 'permission_missing',
      })
      return this.getStatus()
    }

    this.lastVerification = result.ok
      ? { state: 'available', verifiedAt: result.verifiedAt }
      : { state: result.state, reason: result.reason }
    this.setStatus(this.composeVerified(true, acknowledged, this.lastVerification))
    return this.getStatus()
  }

  private composeVerified(
    permission: boolean,
    acknowledged: boolean,
    memo: VerificationMemo | undefined
  ): RegtestAccessStatus {
    if (!memo) {
      return {
        state: 'checking',
        gated: this.status.gated,
        permission,
        acknowledged,
        supported: true,
      }
    }
    return {
      state: memo.state,
      gated: this.status.gated,
      permission,
      acknowledged,
      supported: true,
      ...(memo.reason !== undefined ? { reason: memo.reason } : {}),
      ...(memo.verifiedAt !== undefined ? { verifiedAt: memo.verifiedAt } : {}),
    }
  }

  /**
   * Guard used by every path into regtest. Performs a fresh permission read
   * and identity verification; throws a stable, user-safe WalletError when the
   * capability is not available. Platforms without an adapter are not gated.
   */
  async assertAvailable(): Promise<void> {
    if (!this.adapter) return
    const status = await this.refresh({ verify: true })
    if (status.state !== 'available') {
      throw regtestAccessError(status)
    }
  }

  /**
   * Record the user's acknowledgement after the browser granted the optional
   * permission. The grant is re-read from the browser first: a caller-supplied
   * "granted" flag never reaches this method, so a spoofed UI cannot unlock
   * anything, and consent is only stored once the permission truly exists.
   */
  async acknowledge(): Promise<RegtestAccessStatus> {
    const adapter = this.adapter
    if (!adapter || !this.ackStore) {
      throw new WalletError(ErrorCodes.REGTEST_ACCESS_LOCKED)
    }
    const permission = await adapter.containsPermission()
    if (!permission) {
      this.lastVerification = undefined
      this.setStatus({
        state: 'locked',
        gated: this.status.gated,
        permission: false,
        acknowledged: this.isAcknowledged(),
        supported: true,
        reason: 'permission_missing',
      })
      return this.getStatus()
    }
    if (this.status.gated) {
      await this.ackStore.set(REGTEST_ACCESS_ACK_VERSION)
    }
    return this.refresh({ verify: true })
  }

  /** Drop the acknowledgement; any in-flight verification result is discarded. */
  async clearAcknowledgement(): Promise<void> {
    this.generation += 1
    this.lastVerification = undefined
    if (this.ackStore) {
      await this.ackStore.set(undefined)
    }
    if (this.adapter) {
      this.setStatus({
        state: 'locked',
        gated: this.status.gated,
        permission: this.status.permission,
        acknowledged: this.isAcknowledged(),
        supported: true,
        reason: this.status.permission ? 'acknowledgement_missing' : 'permission_missing',
      })
    }
  }

  /**
   * Invoked from `chrome.permissions.onRemoved` (or any observer that noticed
   * a removal). The permission is re-read instead of trusting the event
   * payload; if it is gone, the capability locks immediately and listeners
   * (the wallet controller) leave regtest.
   */
  async handlePermissionRemoved(): Promise<void> {
    const adapter = this.adapter
    if (!adapter) return
    let permission = false
    try {
      permission = await adapter.containsPermission()
    } catch (error) {
      this.logger?.warn('[RegtestAccess] permission re-check failed after removal event', {
        name: (error as { name?: unknown })?.name,
      })
    }
    if (permission) {
      // An unrelated origin was removed: the loopback grant, the
      // acknowledgement and the last service check all still stand. Keep the
      // memo rather than parking an available capability in `checking` with
      // no verification scheduled to leave that state, and leave any in-flight
      // probe alone.
      this.setStatus(this.composeVerified(true, this.isAcknowledged(), this.lastVerification))
      return
    }
    // The grant really is gone: cancel any in-flight probe and drop the memo.
    this.generation += 1
    this.lastVerification = undefined
    this.setStatus({
      state: 'locked',
      gated: this.status.gated,
      permission: false,
      acknowledged: this.isAcknowledged(),
      supported: true,
      reason: 'permission_missing',
    })
    this.emit('permissionRemoved')
  }

  private setStatus(next: RegtestAccessStatus): void {
    const previous = this.status
    this.status = next
    if (
      previous.state !== next.state ||
      previous.permission !== next.permission ||
      previous.acknowledged !== next.acknowledged ||
      previous.gated !== next.gated ||
      previous.supported !== next.supported ||
      previous.reason !== next.reason
    ) {
      this.emit('changed', this.getStatus())
    }
  }
}

const regtestAccessService = new RegtestAccessService()

export default regtestAccessService
