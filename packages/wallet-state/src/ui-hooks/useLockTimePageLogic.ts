import { ErrorCodes, getAutoLockTimes, resolveAutoLockTimeId } from '@qbit/wallet-shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n, useNavigation, useTools, useWallet } from '../context'
import { useAppDispatch, useAutoLockTimeId } from '../hooks'
import { settingsActions } from '../reducers'

/** How long the chosen time stays in view, ticked, before the screen leaves. */
export const LOCK_TIME_LEAVE_DELAY_MS = 300

export interface LockTimePageOptions {
  /**
   * How the screen leaves: once a lock time is saved, and on Back. History
   * Back (`nav.goBack`) unless given; the extension passes the Back of its
   * header, which has a place to go when nothing is behind the screen.
   */
  leave?: () => void
}

export function useLockTimePageLogic({ leave }: LockTimePageOptions = {}) {
  const { t } = useI18n()
  // The option to check, also for an id a later or earlier build stored.
  const autoLockTimeId = resolveAutoLockTimeId(useAutoLockTimeId())
  const autoLockTimes = getAutoLockTimes(t)
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  const tools = useTools()
  const [loading, setLoading] = useState(false)
  const nav = useNavigation()
  const leaveScreen = leave ?? nav.goBack

  // The leave that follows a save, while it waits.
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set once the screen has left or gone (Back, the leave after a save, or
  // unmounted): a save that answers after that does not leave again, from
  // whatever screen is shown by then.
  const goneRef = useRef(false)

  const cancelPendingLeave = useCallback(() => {
    if (leaveTimerRef.current !== null) {
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    goneRef.current = false
    return (): void => {
      goneRef.current = true
      cancelPendingLeave()
    }
  }, [cancelPendingLeave])

  /** Back: leaves once, also while a save's leave is still waiting. */
  const goBack = useCallback(() => {
    cancelPendingLeave()
    goneRef.current = true
    leaveScreen()
  }, [cancelPendingLeave, leaveScreen])

  const handleSelectOption = async option => {
    if (loading) return

    setLoading(true)
    try {
      const lockTimeId = option.id
      await wallet.setAutoLockTimeId(lockTimeId)
      // @ts-ignore SAFE
      dispatch(settingsActions.updateSettings({ autoLockTimeId: lockTimeId }))
      tools.toastSuccess(`${t('the_auto_lock_time_has_been_changed_to')} ${option.label}`)

      if (!goneRef.current) {
        // One leave, also when another time is chosen while it waits.
        cancelPendingLeave()
        leaveTimerRef.current = setTimeout(() => {
          leaveTimerRef.current = null
          goneRef.current = true
          leaveScreen()
        }, LOCK_TIME_LEAVE_DELAY_MS)
      }
    } catch (error) {
      console.error('Failed to set lock time:', error)
      // The previous value could not be saved again either, so the stored lock
      // time may differ from the one shown.
      if ((error as { code?: unknown } | null)?.code === ErrorCodes.PREFERENCE_NOT_RESTORED) {
        tools.toastError(t('setting_not_saved_may_have_changed'))
      } else {
        tools.toastError((error as Error)?.message || t('unknown_error'))
      }
    } finally {
      setLoading(false)
    }
  }
  return {
    autoLockTimeId,
    autoLockTimes,
    loading,
    handleSelectOption,
    goBack,
  }
}
