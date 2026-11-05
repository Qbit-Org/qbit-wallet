# @qbit/preference-service

## 1.0.0

### Major Changes

- de81656: Remove the signData and deriveContextHash approval screens, the developer-mode setting that allowed signData requests, and the background methods behind them. No provider method opened either screen. Breaking change: `WalletController` no longer has `getEnableSignData`, `setEnableSignData` or `deriveContextHash`, and `UI_CONTROLLER_METHODS` no longer lists the first two, so `getUiControllerMethod` refuses them. `PreferenceService` no longer has `getEnableSignData` or `setEnableSignData`, and `BasePreferenceStore` no longer has `enableSignData`. A stored `enableSignData` value is dropped when the preferences load and is not saved again. In `@qbit/wallet-state`, the `WalletController` interface no longer declares `getEnableSignData` or `setEnableSignData`.

### Patch Changes

- de81656: Add two lock settings: `lockOnComputerLock` and `lockOnWindowsClosed`. Both are on by default, also for preferences stored before they existed, and a missing or malformed stored value reads as on. `getLockOnComputerLock`/`setLockOnComputerLock` and `getLockOnWindowsClosed`/`setLockOnWindowsClosed` read and save them; the setters resolve once the value is on disk and reject a failed save, as the other security settings do.
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
  - @qbit/wallet-shared@3.0.0
  - @qbit/wallet-storage@0.3.2

## 0.3.6

### Patch Changes

- eb9f779: Show only the selected account's transactions in History (#77). `getAddressHistory` read every account of the wallet as one history, so each account listed the others' transactions and a payment between two accounts showed as a transfer to itself in both. It now reads only the selected account's own address, the address its balance reads: the first page, later pages, the snapshot a refresh reuses and the revision probe all cover that one address. A payment between two accounts is a send in the paying account and a receive in the other, with the other account's address as the counterparty. With one address the refresh always uses the revision probe, so history no longer calls `probeQbitAccountHistoryAncestry`. The history key (`scopeKey`, and `useHistoryScopeKey` in `@qbit/wallet-state`) is now `qbit-account:<chain>:<account pubkey>`, one per account, so a snapshot of one account is refused for another and a read that finishes after an account switch is stored under the account it read. `getAddressHistory` and `getAddressCacheHistory` refuse an address that is not the selected account's before reading the explorer, and a refresh whose account changes during its revision probe ends there, whether or not the probe succeeded, instead of scanning the account again. History cached by earlier builds under the wallet-wide `qbit:<chain>:<first account's pubkey>` key is never read, and `@qbit/preference-service` drops those entries when it loads. In `@qbit/wallet-state`, `useFetchHistoryCallback` records a failed read as a history error only while its account is still selected, so a read the background refuses after a switch does not show an error when that account is selected again. Because the cache now holds one entry per account, `updateAddressHistory` keeps only the 16 most recently written entries. Receive selects each new receive address as it moves on, so History then shows that address's transactions, as the balance card does.
- eb9f779: Keep the stored sign-data, auto-lock and replace-by-fee settings in line with memory when a change of one of them fails to save. Before, the previous value put back after a failed save was saved once more and a failure of that save was only logged, so when another save of the preferences had written the rejected value in the meantime, that value stayed on disk: a failed attempt to turn sign-data requests on could still turn them on at the next start. `setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` now try to save the previous value up to three times, 100 and 200 ms apart. They stop at once when `resetAllData` is replacing the store, which then decides what is stored, and stop early when a newer change of the same setting is waiting. When the previous value was not saved, including when a newer change cut the retry short after a failed save, they reject with a `WalletError` whose code is the new `ErrorCodes.PREFERENCE_NOT_RESTORED` (message key `setting_not_saved_may_have_changed`) instead of the error of the first save. The sign-data setting and the auto-lock time page (`useLockTimePageLogic`) then say that the change was not saved and that the stored setting may have changed. The send screen's replace-by-fee switch still only logs a failed save of that setting. The stored preference format does not change.
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
  - @qbit/wallet-shared@2.0.1
  - @qbit/wallet-storage@0.3.1

## 0.3.5

### Patch Changes

- 4091176: Stop losing stored settings and contacts (#18). `PreferenceService.setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` now return a promise that resolves once the new value is on disk, instead of leaving it to the store's 1-second debounced save, so quitting the browser or reloading the extension straight after the change no longer brings the old value back. These changes run one at a time; a failed write rejects and puts the previous value back, and saves it again at once, unless the store was reset or the value changed some other way in the meantime. The wallet controller's `setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` wait for that write. The sign-data and auto-lock settings show the error and keep the setting as it was when the change cannot be saved, and the send screen's RBF switch logs a failure to save the default instead of leaving the rejection unhandled.

  `BaseProxyStorageAdapter.createPersistentProxy` no longer writes the template over the stored data when it cannot read them. It retries the read twice and then rejects, so the service using the store fails to start instead of starting from defaults. Plain objects and arrays below the top level of a persistent proxy are now frozen copies, so a nested write throws instead of changing memory without ever being saved; `PreferenceService` now reassigns the top-level key when it fills in default wallet and account names and UI cache entries. A new `reset` option (`PersistentProxyOptions`) replaces the stored data with the template without reading it, and only the newest proxy for a key saves. The new `flushPersistentProxy` saves a proxy at once, in a single write, and rejects for a proxy that a newer one replaced; `PreferenceService.persist` uses it when the adapter has it. `PreferenceService.resetAllData` can therefore no longer be undone by a save the previous store still had pending or by a `persist` that runs while it resets.

  `ContactBookService` applies each change to a copy of the contact book and keeps it only once it is saved, one change at a time, so a failed write rejects and leaves the contacts as they are on disk. `resetAllData` now returns a promise. The wallet controller's `addContact`, `updateContact` and `removeContact` wait for the write. The extension's background storage now returns all data from `get()` without a key, accepts a write before the first read or after a failed one, keeps a write made while the first read is in flight, makes writes one at a time in call order so a read sees the writes requested before it, and stores and returns copies, so a caller changing an object it read or wrote no longer changes the cache.

  Breaking change: `@qbit/wallet-background` no longer exports `initPersistStoreStorage`, and its unused `createPersistStore` and duplicate `webapi/storage` wrapper are removed.

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
- Updated dependencies [4091176]
- Updated dependencies [4091176]
  - @qbit/wallet-shared@2.0.0
  - @qbit/wallet-storage@0.3.0

## 0.3.4

### Patch Changes

- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/wallet-shared@1.2.0
  - @qbit/wallet-storage@0.2.6

## 0.3.3

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1
  - @qbit/wallet-storage@0.2.5

## 0.3.2

### Patch Changes

- 0abd814: Make local Qbit Regtest available in the Chrome Web Store build behind an optional host-permission gate: the store manifest declares `http://127.0.0.1:3002/*` only as an optional host permission (E2E keeps it required), the background owns a `locked` / `checking` / `available` / `unreachable` / `unexpected_service` capability that re-reads `chrome.permissions.contains()`, a versioned in-app acknowledgement, and a bounded read-only identity check of the local service (`/block-height/0` against the reviewed Qbit regtest genesis hash plus `/blocks/tip/height`) before any UI, dapp, direct-controller, startup or revocation path may enter regtest. The synchronous store-channel `disable` flag and the preference-service regtest rewrite are replaced by capability-aware startup that falls back to Mainnet, and permission revocation while regtest is active returns the wallet to Mainnet through the normal serialized chain transition.
- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0
  - @qbit/wallet-storage@0.2.4

## 0.3.1

### Patch Changes

- b2a1b1a: Serve discovery from a release-pinned Qbit ecosystem catalog and persist only current wallet preferences.
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
  - @qbit/wallet-storage@0.2.3

## 0.3.0

### Minor Changes

- release: minor wave for accumulated wallet toolkit updates since the previous package release.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.3.0
  - @qbit/wallet-storage@0.2.2

## 0.2.0

### Minor Changes

- release: minor wave for accumulated package updates.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.2.0
  - @qbit/wallet-types@1.1.0
  - @qbit/wallet-storage@0.2.1

## 0.1.7

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
- Updated dependencies
  - @qbit/wallet-storage@0.2.0
  - @qbit/wallet-shared@0.1.3
  - @qbit/wallet-types@1.0.1

## 0.1.6

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.1.2

## 0.1.5

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.1.1

## 0.1.4

### Patch Changes

- fix

## 0.1.3

### Patch Changes

- fix

## 0.1.2

### Patch Changes

- fix

## 0.1.1

### Patch Changes

- fix

## 0.1.0

### Patch Changes

- feat: new package
