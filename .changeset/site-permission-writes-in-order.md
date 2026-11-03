---
'@qbit/permission-service': patch
---

Stop a failed save of a site permission from undoing another change. `PermissionService` now saves changes to connected sites one at a time, in the order they were asked for, and each change starts from the sites the change before it left. A save that fails undoes only its own change: it no longer reconnects a site that was disconnected while it was pending, or brings back the sites a reset removed, until the background restarts. A connect or disconnect that was reported as failed is no longer applied after a restart because a later save stored it. A change shows in the service once every change asked for before it has been saved or undone, and a change to a site that is no longer there, such as pinning a site disconnected in the meantime, does nothing.

A disconnect or reset still takes effect at once: from when it is asked for, `hasPermission`, `getConnectedSite`, `getConnectedSites` and `getRecentConnectedSites` treat the site, or every site for a reset, as not connected, even while earlier saves are pending. When the disconnect or reset cannot be saved, the sites keep the grants they had. This covers `removeConnectedSite`, `resetAllData`, `clearAllPermissions`, and `setSite` or `updateConnectSite` with `isConnected: false`.

`setRecentConnectedSites` now only reorders: the stored sites it names come first, in its order, each as it is stored, followed by every other stored site. It no longer adds, removes or changes a site, so a list read before a disconnect cannot reconnect that site, and an origin that is not stored is ignored.
