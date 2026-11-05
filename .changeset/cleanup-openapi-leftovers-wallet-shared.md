---
'@qbit/wallet-shared': major
---

Remove the announcement and notification types and the `ui_openapi` message type, which nothing sends any more. `Announcement`, `AnnouncementLinkType`, `NotificationListItem` and `StoredNotification` are no longer exported, `MESSAGE_TYPE.UI_OPENAPI` is gone, and `WalletConfig` no longer has `moonPayEnabled` or `endpoint`.
