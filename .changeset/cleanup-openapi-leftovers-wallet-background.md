---
'@qbit/wallet-background': major
---

Remove the wallet API and notification services. The wallet sent no request through them: their announcement and notification calls returned empty lists, `getBlockActiveInfo` had no caller, and the wallet configuration and "what's new" notices are bundled with the release. `walletApiService` and `notificationService` are no longer exported, and `@qbit/wallet-api` and `@qbit/notification-service` are no longer peer dependencies; both packages are deleted. `WalletController` drops `getBlockActiveInfo`, `getAnnouncements`, `getNotifications`, `readNotification`, `readAllNotifications`, `deleteNotification` and `getNotificationUnreadCount`, and `UI_CONTROLLER_METHODS` drops the six of them it listed. `getWalletConfig` and `getVersionDetail` stay on the UI port and still return the bundled configuration and notices; the configuration no longer has `moonPayEnabled` or `endpoint`.

A chain switch no longer sets an API endpoint of its own: the explorer clients already follow the selected chain, and leaving regtest still drops the cached loopback clients. Start-up and `resetAllData` no longer write the stored `openapi` record, and start-up no longer reads the stored `notifications` record; both are left in storage as they are.
