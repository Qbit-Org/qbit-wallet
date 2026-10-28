import { AnnouncementLinkType, StoredNotification } from '@qbit/wallet-shared'
import { useCallback, useEffect, useState } from 'react'
import { useI18n, useNavigation, useTools, useWallet } from 'src/context'

export function useUnreadNotificationsCount() {
  const wallet = useWallet()
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    const updateUnreadCount = async () => {
      const count = await wallet.getNotificationUnreadCount()
      setUnreadCount(count)
    }

    updateUnreadCount()

    // Poll every 3 seconds for unread count updates.
    const interval = setInterval(updateUnreadCount, 3000)
    return () => clearInterval(interval)
  }, [wallet])

  return unreadCount
}

export function useNotificationsLogic() {
  const nav = useNavigation()
  const wallet = useWallet()
  const [notifications, setNotifications] = useState<StoredNotification[]>([])
  const [loading, setLoading] = useState(true)

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true)
      const data = await wallet.getNotifications()
      setNotifications(data)
    } catch (error) {
      console.error('Failed to fetch notifications:', error)
      setNotifications([])
    } finally {
      setLoading(false)
    }
  }, [wallet])

  useEffect(() => {
    fetchNotifications()
  }, [fetchNotifications])

  const handleReadNotification = useCallback(
    async (id: string) => {
      await wallet.readNotification(id)
      // Update local state
      setNotifications(prev => prev.map(n => (n.id === id ? { ...n, readAt: Date.now() } : n)))
    },
    [wallet]
  )

  const tools = useTools()
  const { t } = useI18n()
  const handleReadAll = useCallback(async () => {
    await wallet.readAllNotifications()
    // Update local state
    const now = Date.now()
    setNotifications(prev => prev.map(n => ({ ...n, readAt: now })))
    tools.toastSuccess(t('all_marked_as_read'))
  }, [wallet])

  const handleDeleteNotification = useCallback(
    async (id: string) => {
      await wallet.deleteNotification(id)
      // Update local state
      setNotifications(prev => prev.filter(n => n.id !== id))
    },
    [wallet]
  )

  const unreadCount = notifications.filter(n => n.readAt === undefined).length

  const handleCardClick = async (notification: StoredNotification) => {
    if (notification.readAt === undefined) {
      await handleReadNotification(notification.id)
    }
    if (notification.link) {
      if (notification.linkType === AnnouncementLinkType.EXTERNAL_LINK) {
        nav.navToUrl(notification.link, true)
        return
      }
      nav.navToUrl(notification.link)
    }
  }
  const formatTime = (timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return t('just_now')
    if (minutes < 60) return String(minutes) + ' ' + t('minutes_ago')
    if (hours < 24) return String(hours) + ' ' + t('hours_ago')
    if (days < 7) return String(days) + ' ' + t('days_ago')
    return new Date(timestamp).toLocaleDateString()
  }

  return {
    notifications,
    loading,
    unreadCount,
    handleReadNotification,
    handleReadAll,
    handleDeleteNotification,
    fetchNotifications,
    handleCardClick,
    formatTime,
  }
}
