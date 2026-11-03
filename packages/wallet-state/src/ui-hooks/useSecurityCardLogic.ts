import { ErrorCodes } from '@qbit/wallet-shared'
import { useEffect, useRef, useState } from 'react'
import { useI18n, useTools, useWallet } from '../context'

type LockSetting = 'lockOnComputerLock' | 'lockOnWindowsClosed'

/**
 * The Security card's lock settings: lock when the computer locks, and when
 * the last browser window closes. They are undefined until read. One change
 * saves at a time, and `saving` is set meanwhile, so an earlier change cannot
 * land after a newer one. A change that is not saved leaves the setting as it
 * was and is reported as the other security settings report theirs.
 */
export function useSecurityCardLogic() {
  const { t } = useI18n()
  const wallet = useWallet()
  const tools = useTools()
  const [settings, setSettings] = useState<Record<LockSetting, boolean>>()
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    let mounted = true
    Promise.all([wallet.getLockOnComputerLock(), wallet.getLockOnWindowsClosed()])
      .then(([lockOnComputerLock, lockOnWindowsClosed]) => {
        if (mounted) setSettings({ lockOnComputerLock, lockOnWindowsClosed })
      })
      .catch(error => {
        console.error('Failed to read the lock settings:', error)
      })
    return () => {
      mounted = false
    }
  }, [wallet])

  const change = async (setting: LockSetting, enabled: boolean) => {
    if (!settings || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      if (setting === 'lockOnComputerLock') {
        await wallet.setLockOnComputerLock(enabled)
      } else {
        await wallet.setLockOnWindowsClosed(enabled)
      }
      setSettings(current => current && { ...current, [setting]: enabled })
    } catch (error) {
      console.error(`Failed to save ${setting}:`, error)
      // The previous value could not be saved again either, so the switch may
      // not match what the wallet loads after a restart.
      if ((error as { code?: unknown } | null)?.code === ErrorCodes.PREFERENCE_NOT_RESTORED) {
        tools.toastError(t('setting_not_saved_may_have_changed'))
      } else {
        tools.toastError((error as Error)?.message || t('unknown_error'))
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return {
    lockOnComputerLock: settings?.lockOnComputerLock,
    lockOnWindowsClosed: settings?.lockOnWindowsClosed,
    saving,
    changeLockOnComputerLock: (enabled: boolean) => change('lockOnComputerLock', enabled),
    changeLockOnWindowsClosed: (enabled: boolean) => change('lockOnWindowsClosed', enabled),
  }
}
