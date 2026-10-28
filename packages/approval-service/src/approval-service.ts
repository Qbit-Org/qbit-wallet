import { ErrorCodes, WalletError } from '@qbit/wallet-shared'
import { EventEmitter } from 'eventemitter3'
import { Approval, ApprovalData, PendingApproval } from './types'

// 128 bits from the platform CSPRNG, so an approval can be settled only by a
// window that was handed its id.
function createApprovalId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

// something need user approval in window
// should only open one window, unfocus will close the current notification
export class ApprovalService extends EventEmitter {
  approval: Approval | null = null
  public approvalWindowId = 0
  // The approval approvalWindowId was opened for. Removing that window rejects
  // that approval only, never one that replaced it.
  private approvalWindowApprovalId: string | undefined
  // Windows removed while an approval window was still opening, before its id
  // was known: that window may be one of them.
  private openingWindows = 0
  private windowsRemovedWhileOpening = new Set<number>()
  isLocked = false

  constructor() {
    super()
  }

  init() {
    // Initialize window event listeners if available
    // This will be implemented by the platform-specific adapter
  }

  getApproval = (): PendingApproval | undefined =>
    this.approval ? { id: this.approval.id, data: this.approval.data } : undefined

  /**
   * resolveApproval and rejectApproval settle the pending approval only when
   * `id` is the id getApproval reported for it, and check it without an await
   * before settling. With any other id, or none pending, they change nothing
   * and return false.
   */
  resolveApproval = async (id: string, data?: any, forceReject = false): Promise<boolean> => {
    const approval = this.takeApproval(id)
    if (!approval) return false
    if (forceReject) {
      approval.reject(new WalletError(ErrorCodes.UserCancel, 'User Cancel'))
    } else {
      approval.resolve(data)
    }
    await this.clear()
    this.emit('resolve', data)
    return true
  }

  rejectApproval = async (
    id: string,
    err?: string,
    stay = false,
    isInternal = false
  ): Promise<boolean> => {
    const approval = this.takeApproval(id)
    if (!approval) return false
    if (isInternal) {
      approval.reject(new WalletError(ErrorCodes.UserCancel, err))
    } else {
      approval.reject(new WalletError(ErrorCodes.UserCancel, err))
    }

    await this.clear(stay)
    this.emit('reject', err)
    return true
  }

  // Detaches the pending approval if `id` is its id. The id arrives from a UI
  // port, so anything but that exact string matches nothing.
  private takeApproval(id: unknown): Approval | undefined {
    const approval = this.approval
    if (!approval || typeof id !== 'string' || id !== approval.id) return undefined
    this.approval = null
    return approval
  }

  // currently it only support one approval at the same time
  requestApproval = async (data: ApprovalData, winProps?: any): Promise<any> => {
    if (this.approval) {
      if (this.approvalWindowId) {
        try {
          await this.platformFocusWindow(this.approvalWindowId)
        } catch (e) {
          // keep original behavior even if focusing existing window fails
        }
      }
      throw new WalletError(ErrorCodes.UNKNOWN, 'Another approval request is already pending')
    }

    const id = createApprovalId()
    return new Promise((resolve, reject) => {
      this.approval = {
        id,
        data,
        resolve,
        reject,
      }

      this.openNotification(winProps, id)
    })
  }

  clear = async (stay = false) => {
    this.approval = null
    if (this.approvalWindowId && !stay) {
      const windowId = this.approvalWindowId
      // Closing a notification can synchronously trigger its beforeunload rejection.
      // Reset first so that re-entrant cleanup cannot close the same window twice.
      this.approvalWindowId = 0
      this.approvalWindowApprovalId = undefined
      await this.platformCloseWindow(windowId)
    }
  }

  unLock = () => {
    this.isLocked = false
  }

  lock = () => {
    this.isLocked = true
  }

  /** Opens the approval window for `approvalId`, by default the pending approval. */
  openNotification = async (winProps?: any, approvalId = this.approval?.id) => {
    if (this.approvalWindowId) {
      const windowId = this.approvalWindowId
      // Detach the old window before closing it so its removal callback cannot
      // reject the replacement approval that requestApproval already installed.
      this.approvalWindowId = 0
      this.approvalWindowApprovalId = undefined
      try {
        await this.platformCloseWindow(windowId)
      } catch {
        // The retained window may already be gone; the replacement still needs a window.
      }
    }
    let windowId: number
    this.openingWindows += 1
    try {
      windowId = await this.platformOpenWindow(winProps)
    } catch (error) {
      this.finishOpening()
      if (approvalId === undefined) throw error
      // No window can show the approval, so nothing else would ever settle it.
      // The wallet failed here, not the user, so this is no UserCancel.
      const approval = this.takeApproval(approvalId)
      if (approval) {
        approval.reject(new WalletError(ErrorCodes.UNKNOWN, 'Approval window failed to open'))
        this.emit('reject', 'Approval window failed to open')
      }
      return
    }
    const removedWhileOpening = this.finishOpening(windowId)
    if (approvalId !== undefined && this.approval?.id !== approvalId) {
      // The approval settled, or another replaced it, while this window opened.
      // Kept, the window would displace the current approval's own window and
      // its removal would no longer reject that approval.
      if (!removedWhileOpening) {
        try {
          await this.platformCloseWindow(windowId)
        } catch {
          // Already gone.
        }
      }
      return
    }
    if (removedWhileOpening) {
      // The user closed the window before it finished opening.
      if (approvalId !== undefined) await this.rejectApproval(approvalId)
      return
    }
    this.approvalWindowId = windowId
    this.approvalWindowApprovalId = approvalId
  }

  // Ends one window open, and returns whether `windowId` was removed meanwhile.
  private finishOpening(windowId?: number): boolean {
    this.openingWindows -= 1
    const removed = windowId !== undefined && this.windowsRemovedWhileOpening.delete(windowId)
    if (this.openingWindows === 0) this.windowsRemovedWhileOpening.clear()
    return removed
  }

  /**
   * Rejects the approval the removed window was opened for while it is still
   * pending, and returns whether it did.
   */
  handleWindowRemoved = async (windowId: number): Promise<boolean> => {
    if (windowId !== this.approvalWindowId) {
      if (this.openingWindows > 0) this.windowsRemovedWhileOpening.add(windowId)
      return false
    }

    const approvalId = this.approvalWindowApprovalId
    this.approvalWindowId = 0
    this.approvalWindowApprovalId = undefined
    if (approvalId === undefined) {
      return false
    }
    return this.rejectApproval(approvalId)
  }

  platformOpenWindow = async (winProps?: any): Promise<number> => {
    return 1 // Placeholder implementation
  }

  platformCloseWindow = async (windowId: number) => {
    // todo
  }

  platformFocusWindow = async (windowId: number) => {
    // todo
  }
}
