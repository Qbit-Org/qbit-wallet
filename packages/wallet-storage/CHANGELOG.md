# @qbit/wallet-storage

## 0.3.0

### Minor Changes

- 4091176: Stop losing stored settings and contacts (#18). `PreferenceService.setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` now return a promise that resolves once the new value is on disk, instead of leaving it to the store's 1-second debounced save, so quitting the browser or reloading the extension straight after the change no longer brings the old value back. These changes run one at a time; a failed write rejects and puts the previous value back, and saves it again at once, unless the store was reset or the value changed some other way in the meantime. The wallet controller's `setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` wait for that write. The sign-data and auto-lock settings show the error and keep the setting as it was when the change cannot be saved, and the send screen's RBF switch logs a failure to save the default instead of leaving the rejection unhandled.

  `BaseProxyStorageAdapter.createPersistentProxy` no longer writes the template over the stored data when it cannot read them. It retries the read twice and then rejects, so the service using the store fails to start instead of starting from defaults. Plain objects and arrays below the top level of a persistent proxy are now frozen copies, so a nested write throws instead of changing memory without ever being saved; `PreferenceService` now reassigns the top-level key when it fills in default wallet and account names and UI cache entries. A new `reset` option (`PersistentProxyOptions`) replaces the stored data with the template without reading it, and only the newest proxy for a key saves. The new `flushPersistentProxy` saves a proxy at once, in a single write, and rejects for a proxy that a newer one replaced; `PreferenceService.persist` uses it when the adapter has it. `PreferenceService.resetAllData` can therefore no longer be undone by a save the previous store still had pending or by a `persist` that runs while it resets.

  `ContactBookService` applies each change to a copy of the contact book and keeps it only once it is saved, one change at a time, so a failed write rejects and leaves the contacts as they are on disk. `resetAllData` now returns a promise. The wallet controller's `addContact`, `updateContact` and `removeContact` wait for the write. The extension's background storage now returns all data from `get()` without a key, accepts a write before the first read or after a failed one, keeps a write made while the first read is in flight, makes writes one at a time in call order so a read sees the writes requested before it, and stores and returns copies, so a caller changing an object it read or wrote no longer changes the cache.

  Breaking change: `@qbit/wallet-background` no longer exports `initPersistStoreStorage`, and its unused `createPersistStore` and duplicate `webapi/storage` wrapper are removed.

### Patch Changes

- 4091176: Retry a failed save of a store's template instead of rejecting at once. When nothing is stored under a key, as for the settings on a first install, `createPersistentProxy` saves the template before it returns the proxy. 1.0.5 tried that write twice, because its fallback for a failed read wrote the template again. With that fallback gone, one failed write rejected, so `PreferenceService.init` failed and the extension's background did not finish starting until its service worker restarted. The template is now written up to three times, 100 and 200 ms apart, like a failed read, and the proxy rejects only when every attempt fails. Every attempt writes the same value, and a retry is skipped once a newer proxy owns the key, so the template cannot land after that proxy's writes. A reset saves its template the same way. A failed read still rejects without writing anything, and stored data is never replaced by the template.
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
  - @qbit/wallet-shared@2.0.0

## 0.2.6

### Patch Changes

- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/wallet-shared@1.2.0

## 0.2.5

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1

## 0.2.4

### Patch Changes

- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0

## 0.2.3

### Patch Changes

- Updated dependencies [a1458e0]
- Updated dependencies [f1bb656]
- Updated dependencies [b2a1b1a]
- Updated dependencies [688e9cb]
- Updated dependencies [213b242]
- Updated dependencies [3f39e95]
- Updated dependencies [a63aaf3]
- Updated dependencies [a25cee5]
- Updated dependencies [3c57bcf]
- Updated dependencies [64cc0ee]
- Updated dependencies [c83de12]
- Updated dependencies [917a499]
- Updated dependencies [0cd8709]
  - @qbit/wallet-shared@1.0.0

## 0.2.2

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.2.0
  - @qbit/wallet-types@1.1.0

## 0.2.0

### Minor Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.1.3
  - @qbit/wallet-types@1.0.1
