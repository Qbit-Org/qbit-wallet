# @qbit/permission-service

## 2.0.1

### Patch Changes

- de81656: Stop a failed save of a site permission from undoing another change. `PermissionService` now saves changes to connected sites one at a time, in the order they were asked for, and each change starts from the sites the change before it left. A save that fails undoes only its own change: it no longer reconnects a site that was disconnected while it was pending, or brings back the sites a reset removed, until the background restarts. A connect or disconnect that was reported as failed is no longer applied after a restart because a later save stored it. A change shows in the service once every change asked for before it has been saved or undone, and a change to a site that is no longer there, such as pinning a site disconnected in the meantime, does nothing.

  A disconnect or reset still takes effect at once: from when it is asked for, `hasPermission`, `getConnectedSite`, `getConnectedSites` and `getRecentConnectedSites` treat the site, or every site for a reset, as not connected, even while earlier saves are pending. When the disconnect or reset cannot be saved, the sites keep the grants they had. This covers `removeConnectedSite`, `resetAllData`, `clearAllPermissions`, and `setSite` or `updateConnectSite` with `isConnected: false`.

  `setRecentConnectedSites` now only reorders: the stored sites it names come first, in its order, each as it is stored, followed by every other stored site. It no longer adds, removes or changes a site, so a list read before a disconnect cannot reconnect that site, and an origin that is not stored is ignored.

  - @qbit/wallet-storage@0.3.2

## 2.0.0

### Major Changes

- eb9f779: Store connected-site permissions in a record the wallet owns, `{ version: 1, sites }` with the most recently used site first, instead of lru-cache 6's internal dump, and drop the lru-cache dependency. `PermissionService.init` still reads the dump that 1.0.6 and earlier wrote, with every grant, chain, pin, signing and quick multi-sign setting in it, and the record is rewritten in the new form on the next change to a site rather than at start-up. A site entry that 1.0.6 kept under a key other than its own origin is kept under that key, which is the origin 1.0.6 checked the grant by. A record that is not an object, has a version this release does not know or has no list of sites is rejected as a whole: the service logs why, does not throw, and starts with no site connected, so each site has to connect again. Within a record that can be read, a site with a missing or wrongly typed field, an expiry, a key that differs from its origin and is not an origin itself, or an origin that appears more than once is dropped on its own and logged, and the other sites keep their grants. A change that would store such a site is rolled back and rejects instead of being written. `updateConnectSite` keeps a site under the origin it was given, even when the new value names another. The service still keeps at most 1000 sites and drops the least recently used.

  A change to a site made before `init` has loaded the stored record now rejects instead of resolving without storing anything. `resetAllData` and `clearAllPermissions` store the empty record even when `init` could not read the stored one, so a reset no longer leaves grants on disk for the next start, and they reject when that write fails.

  The package index now also exports the `LRUCacheDumpStore` and `LRUEntry` types.

  Breaking change: the exported `PermissionStore` type now describes the versioned record, and the dump's shape is `LRUCacheDumpStore`. Once this release has rewritten the record, a downgrade to 1.0.6 reads no grants, so every site has to connect again. 1.0.6 then keeps the versioned sites and adds its own dump beside them; when this release starts on such a record it reads the dump, which holds what was done after the downgrade, and not the versioned sites, which 1.0.6 never showed and so could not have been disconnected.

  The extension's background now starts each service under its own error handling. When the permission service fails to start, the contact book, notifications, phishing protection and the rest of the background still start, with no site connected and changes to site permissions refused. A storage read the browser refuses still stops start-up and reports that the stored settings could not be read.

### Patch Changes

- Updated dependencies [eb9f779]
  - @qbit/wallet-storage@0.3.1

## 1.1.7

### Patch Changes

- Updated dependencies [4091176]
- Updated dependencies [4091176]
  - @qbit/wallet-storage@0.3.0

## 1.1.6

### Patch Changes

- @qbit/wallet-storage@0.2.6

## 1.1.5

### Patch Changes

- @qbit/wallet-storage@0.2.5

## 1.1.4

### Patch Changes

- @qbit/wallet-storage@0.2.4

## 1.1.3

### Patch Changes

- @qbit/wallet-storage@0.2.3

## 1.1.2

### Patch Changes

- Respect `autoSync` and `internalRequestOrigin` options when initializing `PermissionService`.

## 1.1.1

### Patch Changes

- @qbit/wallet-storage@0.2.2

## 1.1.0

### Minor Changes

- release: minor wave for accumulated package updates.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@1.1.0
  - @qbit/wallet-storage@0.2.1

## 1.0.1

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
- Updated dependencies
  - @qbit/wallet-storage@0.2.0
  - @qbit/wallet-types@1.0.1

## 1.0.0

### Major Changes

- release first major version

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@1.0.0

## 0.1.10

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@0.2.1

## 0.1.9

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@0.2.0
