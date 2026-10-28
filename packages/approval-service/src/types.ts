/** A provider request the user approves in an approval component. */
export interface ProviderApprovalData {
  state?: number
  params?: any
  origin?: string
  approvalComponent: string
  requestDefer?: Promise<any>
  approvalType?: string
}

/** The provider's request to unlock the wallet, which unlocking answers. */
export interface UnlockApprovalData {
  lock: true
}

export type ApprovalData = ProviderApprovalData | UnlockApprovalData

export interface Approval {
  /** Unguessable, and new for every requestApproval. */
  id: string
  data: ApprovalData
  resolve(params?: any): void
  reject(err: any): void
}

/**
 * The pending approval as getApproval reports it. A window that renders `data`
 * settles it by passing `id` to resolveApproval or rejectApproval, which act
 * only while that approval is still the pending one.
 */
export interface PendingApproval {
  id: string
  data: ApprovalData
}
