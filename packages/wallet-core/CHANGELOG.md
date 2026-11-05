# @qbit/wallet-core

## 1.1.6

### Patch Changes

- eb9f779: Use `@qbit-oss/protocol` 0.1.1. The address helpers this package uses return the same addresses and scripts as before.
- eb9f779: Name pay-to-anchor outputs in website PSBT approvals and bound their value (#88, #115). A website's `signPsbt`, or any PSBT in its `signPsbts`, is refused before approval, and before any signature counter moves, when that PSBT's pay-to-anchor (P2A, `51024e73`) outputs carry more than 330 sats together. Anchors within that bound get the `anchor` output role and raise no unrecognised-output risk, and the approval shows them as fee anchors; their value still counts as paid to others when the fee is judged. `decodePsbt` types an output with no address as `p2a` or `unknown_script`, so the approval names it by its script instead of showing an empty recipient; outputs with an address keep their shape.

  `@qbit/wallet-core` adds `isPayToAnchorScript`. `@qbit/wallet-shared` adds `QBIT_P2A_MAX_VALUE`, the `anchor` member of `PsbtOutputRole`, and `DecodedPsbtScriptOutput`, the `p2a` and `unknown_script` members of `DecodedPsbtOutput`.

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

## 1.1.5

### Patch Changes

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

## 1.1.4

### Patch Changes

- 6f06a0b: Take the Qbit SDK from npm. `@qbit/pqc`, `@qbit/protocol` and `@qbit/api` are now the npm packages `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api` at exactly 0.1.0, published with provenance from the signed `v0.1.0` tags of Qbit-Org/qbit-pqc and Qbit-Org/qbit-js. Keys, addresses, descriptors, sighashes and signatures are unchanged. Through the new SDK the wallet refuses, before signing, a PSBT input that requests a sighash type other than `SIGHASH_DEFAULT`, a PSBT that pays an output qbit Core's restricted-output rule rejects, and a message with an unpaired UTF-16 surrogate. A finalized provider PSBT keeps the input fields qbit Core keeps, and one carrying another key's signature on the account's input now finalizes. P2MR message approvals and `verifyMessage` bind the proof to the expected address through `verifyP2mrMessageProof`'s new options, and only the canonical lowercase proof address verifies. A broadcast that `@qbit-oss/api` reports as `unknown_outcome` keeps its network, timeout, server or invalid-response reason and stays inconclusive; raw transaction bytes the client refuses make a fee bump `unverifiable`; and address-history reads pass twice the one-read budget, because the client reads an address again when its statistics move during the first read.
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/wallet-shared@1.2.0

## 1.1.3

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1

## 1.1.2

### Patch Changes

- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0

## 1.1.1

### Patch Changes

- f1bb656: Match qbit Core P2MR transaction sizing and its 2,855-sat dust policy across address decoding, sends, and transaction UTXO helpers; expose the shared estimator; and add an explicit ESM Qbit keyring entry for the live conformance runner.
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

## 1.1.0

### Minor Changes

- release: minor wave for accumulated package updates.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@1.1.0

## 1.0.1

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
- Updated dependencies
  - @qbit/wallet-types@1.0.1

## 1.0.0

### Major Changes

- release first major version

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@1.0.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@0.2.1

## 0.2.0

### Minor Changes

- reorg

### Patch Changes

- Updated dependencies
  - @qbit/wallet-types@0.2.0

## 0.1.13

### Patch Changes

- fix

## 0.1.9

### Patch Changes

- fix: readonly keyring
