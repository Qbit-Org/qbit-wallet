import { getAutoLockTimes } from '@qbit/wallet-shared'
import { useState } from 'react'
import { useI18n, useNavigation, useTools, useWallet } from '../context'
import { useAppDispatch, useAutoLockTimeId } from '../hooks'
import { settingsActions } from '../reducers'

export function useLockTimePageLogic() {
  const { t } = useI18n()
  const autoLockTimeId = useAutoLockTimeId()
  const autoLockTimes = getAutoLockTimes(t)
  const dispatch = useAppDispatch()
  const wallet = useWallet()
  const tools = useTools()
  const [loading, setLoading] = useState(false)
  const nav = useNavigation()

  const handleSelectOption = async option => {
    if (loading) return

    setLoading(true)
    try {
      const lockTimeId = option.id
      await wallet.setAutoLockTimeId(lockTimeId)
      // @ts-ignore SAFE
      dispatch(settingsActions.updateSettings({ autoLockTimeId: lockTimeId }))
      tools.toastSuccess(`${t('the_auto_lock_time_has_been_changed_to')} ${option.label}`)

      setTimeout(() => {
        nav.goBack()
      }, 300)
    } catch (error) {
      console.error('Failed to set lock time:', error)
      tools.toastError((error as Error)?.message || t('unknown_error'))
    } finally {
      setLoading(false)
    }
  }
  return {
    autoLockTimeId,
    autoLockTimes,
    loading,
    handleSelectOption,
  }
}
