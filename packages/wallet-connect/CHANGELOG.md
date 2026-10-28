# @qbit/wallet-connect

## 0.2.2

### Patch Changes

- 6f06a0b: Take the Qbit SDK from npm. `@qbit/pqc`, `@qbit/protocol` and `@qbit/api` are now the npm packages `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api` at exactly 0.1.0, published with provenance from the signed `v0.1.0` tags of Qbit-Org/qbit-pqc and Qbit-Org/qbit-js. Keys, addresses, descriptors, sighashes and signatures are unchanged. Through the new SDK the wallet refuses, before signing, a PSBT input that requests a sighash type other than `SIGHASH_DEFAULT`, a PSBT that pays an output qbit Core's restricted-output rule rejects, and a message with an unpaired UTF-16 surrogate. A finalized provider PSBT keeps the input fields qbit Core keeps, and one carrying another key's signature on the account's input now finalizes. P2MR message approvals and `verifyMessage` bind the proof to the expected address through `verifyP2mrMessageProof`'s new options, and only the canonical lowercase proof address verifies. A broadcast that `@qbit-oss/api` reports as `unknown_outcome` keeps its network, timeout, server or invalid-response reason and stays inconclusive; raw transaction bytes the client refuses make a fee bump `unverifiable`; and address-history reads pass twice the one-read budget, because the client reads an address again when its statistics move during the first read.

## 0.2.1

### Patch Changes

- Allow wallet listener callbacks to receive provider event arguments.

## 0.2.0

### Minor Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
