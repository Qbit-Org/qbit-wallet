# @qbit/wallet-api

## 2.1.3

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

## 2.1.2

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1
  - @qbit/wallet-storage@0.2.5

## 2.1.1

### Patch Changes

- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0
  - @qbit/wallet-storage@0.2.4

## 2.1.0

### Minor Changes

- 7379e1e: Back the "what's new" version notice with release-bundled content: `getVersionDetail` now resolves from a new `LOCAL_VERSION_NOTICES` map (exported with `getLocalVersionNotice`) instead of always returning an empty stub. Versions without an entry still resolve to an empty notice, and nothing is fetched remotely.

## 2.0.0

### Major Changes

- 688e9cb: Keep API headers limited to request requirements and keep platform state free of generated
  wallet identifiers.

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

## 1.2.0

### Minor Changes

- release: minor wave for accumulated wallet toolkit updates since the previous package release.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.3.0
  - @qbit/wallet-storage@0.2.2

## 1.1.0

### Minor Changes

- release: minor wave for accumulated package updates.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.2.0
  - @qbit/wallet-types@1.1.0
  - @qbit/wallet-storage@0.2.1

## 1.0.1

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
- Updated dependencies
  - @qbit/wallet-storage@0.2.0
  - @qbit/wallet-shared@0.1.3
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

## 0.1.7

### Patch Changes

- fix: preserve baseURL path when building request URLs
