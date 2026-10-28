/**
 * Background-owned capability describing whether the wallet may use the local
 * Qbit regtest service. The state is derived from the browser permission, the
 * versioned in-app acknowledgement and the latest endpoint verification; it is
 * never persisted as a standalone "enabled" flag.
 */
export type RegtestAccessState =
  /** Acknowledgement or browser permission is missing. */
  | 'locked'
  /** Permission and acknowledgement exist; endpoint verification is running. */
  | 'checking'
  /** Acknowledgement, permission and the latest endpoint verification are valid. */
  | 'available'
  /** Permission exists but the expected service did not answer. */
  | 'unreachable'
  /** The origin answered but did not identify as the Qbit regtest API. */
  | 'unexpected_service'

/** Fixed, user-safe reasons; never derived from a local-service response body. */
export type RegtestAccessReason =
  | 'permission_missing'
  | 'acknowledgement_missing'
  | 'network_error'
  | 'timeout'
  | 'redirect'
  | 'http_status'
  | 'content_type'
  | 'oversized'
  | 'malformed'
  | 'genesis_mismatch'
  | 'tip_unavailable'

export interface RegtestAccessStatus {
  state: RegtestAccessState
  /**
   * True when the loopback origin is an optional permission in this build,
   * i.e. the explanation/acknowledgement flow applies. Builds that ship the
   * origin as a required permission (E2E, local development) are not gated.
   */
  gated: boolean
  /** Result of the most recent `permissions.contains()` check. */
  permission: boolean
  /** Whether the current acknowledgement version has been recorded. */
  acknowledged: boolean
  /** Whether the running build can verify and use the loopback service at all. */
  supported: boolean
  reason?: RegtestAccessReason
  /** Epoch milliseconds of the last completed verification, if any. */
  verifiedAt?: number
}
