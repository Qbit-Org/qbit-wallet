/* eslint-disable indent */
import React, { useContext } from 'react'

/**
 * The pending approval as the background's getApproval reports it: `data` is
 * what a window renders, and `id` settles that approval and no other.
 */
export interface PendingApproval {
  id: string
  data: any
}

export interface ApprovalContextType {
  getApproval: () => Promise<PendingApproval | undefined>
  /**
   * Settle the approval whose id the screen rendered; `undefined` (it rendered
   * none) settles nothing. Resolves false when that approval is no longer
   * pending, which leaves any approval that replaced it pending.
   */
  resolveApproval: (
    approvalId: string | undefined,
    data?: any,
    stay?: boolean,
    forceReject?: boolean
  ) => Promise<boolean>
  rejectApproval: (
    approvalId: string | undefined,
    reason?: string,
    stay?: boolean,
    isInternal?: boolean
  ) => Promise<boolean>
}

const initContext = {
  getApproval: () => {
    return Promise.resolve(undefined)
  },
  resolveApproval: (
    approvalId: string | undefined,
    data?: any,
    stay?: boolean,
    forceReject?: boolean
  ) => {
    return Promise.resolve(false)
  },
  rejectApproval: (
    approvalId: string | undefined,
    reason?: string,
    stay?: boolean,
    isInternal?: boolean
  ) => {
    return Promise.resolve(false)
  },
}

export const ApprovalContext = React.createContext<ApprovalContextType>(initContext)

export function useApproval() {
  const ctx = useContext(ApprovalContext)
  return ctx
}
