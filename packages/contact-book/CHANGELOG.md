# @qbit/contact-book

## 1.1.8

### Patch Changes

- de81656: Adding or editing a contact no longer clears its alias flag or silently replaces another contact. `updateContact`, `addContact` and `replaceContact` now take `isAlias` as optional: left unset, the stored entry keeps the alias flag of the entry already under the contact's address and chain, and a contact stored at an address with no entry gets `false`. A caller that sets `isAlias` still decides it. `addContact` is no longer the same as `updateContact`: it rejects with `ContactAlreadyExistsError` (`code` `CONTACT_ALREADY_EXISTS`) and changes nothing when a contact is already stored under the address and chain. `replaceContact` rejects the same way when another contact is stored under the new address and chain. Both check the store at the time of the write, so a screen that loaded before that contact was added cannot overwrite it. Address matching is exact, as in the stored key. Adding at an alias-only entry, editing a contact under its own address and chain, and moving it onto an alias-only entry all still save. `updateContact` still writes over the entry under its key. The wallet controller's `addContact` is now open to the wallet's own pages. The add and edit screen (`useEditContactScreenLogic`) no longer sends `isAlias`. It adds with `addContact`, moves with `replaceContact` and saves in place with `updateContact`. Before an add or a move, it checks the address, and in that case or when the contact book refuses, it shows "Another contact already has this address on this network" instead of saving. The message clears when the address changes.
  - @qbit/wallet-storage@0.3.2

## 1.1.7

### Patch Changes

- eb9f779: Keep a contact's place in the list when it is edited. `updateContact` and `replaceContact` now keep the stored contact's `sortIndex` unless `data` sets one, so renaming a contact, or changing its address or network, no longer moves it to the top after the user has reordered the list. `replaceContact` takes the `sortIndex` of the contact it replaces and stores the new entry where the old one was, so it also keeps its place among contacts that share a `sortIndex`, as contacts the user never reordered do. A new contact, including one added for an address that has only an alias, still gets 0. `replaceContact` is still one write, and a failed write still changes nothing.
- eb9f779: Stop losing a contact when changing its address or network fails to save. The new `ContactBookService.replaceContact(address, chain, data)` removes the contact under the old address and network and stores `data` in one write. The result is the one `removeContact` followed by `updateContact` gave, except that the contact keeps its place in the list: an old entry that is also an alias stays as an alias, the new entry is stored where the old contact was, with the given `sortIndex` or else the old contact's, and an entry already stored under the new address is replaced. A failed write rejects and leaves the original contact in place, in memory and on disk. The stored contact book keeps its key and shape. The wallet controller's new `replaceContact` is open to the wallet's own pages, and `useEditContactScreenLogic` uses it when the address or network changes, so a failed save keeps the contact under its old address.
- Updated dependencies [eb9f779]
  - @qbit/wallet-storage@0.3.1

## 1.1.6

### Patch Changes

- 4091176: Stop losing stored settings and contacts (#18). `PreferenceService.setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` now return a promise that resolves once the new value is on disk, instead of leaving it to the store's 1-second debounced save, so quitting the browser or reloading the extension straight after the change no longer brings the old value back. These changes run one at a time; a failed write rejects and puts the previous value back, and saves it again at once, unless the store was reset or the value changed some other way in the meantime. The wallet controller's `setEnableSignData`, `setAutoLockTimeId` and `setEnableRBF` wait for that write. The sign-data and auto-lock settings show the error and keep the setting as it was when the change cannot be saved, and the send screen's RBF switch logs a failure to save the default instead of leaving the rejection unhandled.

  `BaseProxyStorageAdapter.createPersistentProxy` no longer writes the template over the stored data when it cannot read them. It retries the read twice and then rejects, so the service using the store fails to start instead of starting from defaults. Plain objects and arrays below the top level of a persistent proxy are now frozen copies, so a nested write throws instead of changing memory without ever being saved; `PreferenceService` now reassigns the top-level key when it fills in default wallet and account names and UI cache entries. A new `reset` option (`PersistentProxyOptions`) replaces the stored data with the template without reading it, and only the newest proxy for a key saves. The new `flushPersistentProxy` saves a proxy at once, in a single write, and rejects for a proxy that a newer one replaced; `PreferenceService.persist` uses it when the adapter has it. `PreferenceService.resetAllData` can therefore no longer be undone by a save the previous store still had pending or by a `persist` that runs while it resets.

  `ContactBookService` applies each change to a copy of the contact book and keeps it only once it is saved, one change at a time, so a failed write rejects and leaves the contacts as they are on disk. `resetAllData` now returns a promise. The wallet controller's `addContact`, `updateContact` and `removeContact` wait for the write. The extension's background storage now returns all data from `get()` without a key, accepts a write before the first read or after a failed one, keeps a write made while the first read is in flight, makes writes one at a time in call order so a read sees the writes requested before it, and stores and returns copies, so a caller changing an object it read or wrote no longer changes the cache.

  Breaking change: `@qbit/wallet-background` no longer exports `initPersistStoreStorage`, and its unused `createPersistStore` and duplicate `webapi/storage` wrapper are removed.

- Updated dependencies [4091176]
- Updated dependencies [4091176]
  - @qbit/wallet-storage@0.3.0

## 1.1.5

### Patch Changes

- @qbit/wallet-storage@0.2.6

## 1.1.4

### Patch Changes

- @qbit/wallet-storage@0.2.5

## 1.1.3

### Patch Changes

- @qbit/wallet-storage@0.2.4

## 1.1.2

### Patch Changes

- @qbit/wallet-storage@0.2.3

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

## 0.1.8

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@0.2.1

## 0.1.7

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@0.2.0
