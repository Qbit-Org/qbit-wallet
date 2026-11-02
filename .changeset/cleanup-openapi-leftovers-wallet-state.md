---
'@qbit/wallet-state': major
---

Remove the notification and announcement state, which only ever held empty lists. `useNotificationsLogic`, `useUnreadNotificationsCount` (and the 3-second poll behind it), `useAnnouncementCardLogic`, `StorageContext`, `useStorage`, `createStorageProvider` and the `StorageContextType` type are no longer exported. The `WalletController` interface drops `openapi`, `getBlockActiveInfo`, `getAnnouncements`, `getNotifications`, `readNotification`, `readAllNotifications`, `deleteNotification` and `getNotificationUnreadCount`, and `RouteTypes` drops `NotificationListScreen`. The settings state's `walletConfig` no longer has `moonPayEnabled` or `endpoint`.
