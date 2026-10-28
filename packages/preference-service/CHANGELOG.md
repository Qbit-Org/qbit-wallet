# @qbit/preference-service

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
