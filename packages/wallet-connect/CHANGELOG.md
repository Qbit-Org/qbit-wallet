# @qbit/wallet-connect

## 0.3.0

### Minor Changes

- de81656: `QbitWallet.init` finds Qbit Wallet as soon as it is ready: it listens for the wallet's `qbit#initialized` and `qbit:announceProvider` events, asks for an announcement with `qbit:requestProvider`, and keeps polling `window.qbit` as before, for the same 5.5 seconds at most. An event only prompts another check of `window.qbit`, since a page can fake it, and the provider in an announcement is never used. The event names are exported as `QBIT_PROVIDER_INITIALIZED_EVENT`, `QBIT_ANNOUNCE_PROVIDER_EVENT` and `QBIT_REQUEST_PROVIDER_EVENT`.

## 0.2.3

### Patch Changes

- eb9f779: Use `@qbit-oss/protocol` 0.1.1. This package takes only the `P2mrMessageProof` type from it, which is unchanged.
- eb9f779: A website's `switchChain` or `switchNetwork` requested while the wallet is locked now asks the user to unlock first, and then shows the switch approval for the unlocked account, so the switch succeeds once the user approves it. Before, the approval was shown with the locked wallet's empty account, and after the unlock and approval the request failed with "Qbit provider context changed during approval". A switch still needs the user's approval, and an approval answered after the account or chain changed still fails. The SwitchNetwork approval screen now renders the network the website asked for; it read a field the request does not carry and failed to render. `chainForNetwork`, which maps a provider network name to its chain, is now exported by `@qbit/wallet-shared`, so the background and the approval screen share it.

  In `@qbit/wallet-connect`, `QbitWallet.requestAccount()` now connects first with `requestAccounts()`, and only then, when the wallet is on another chain than the one the dapp is set up for, calls `switchChain()`. The user approves the switch as its own step, and the account returned is the one on the new chain, or none if the wallet has left that chain again. A `4100` from that `switchChain()` leads to one more `requestAccounts()` and a second switch only when the wallet's active chain changed after connecting; otherwise, as when the user disconnected the site during the approval, the `4100` is passed on. Before, it switched first, which a website that was not connected yet could not do, so the connection failed.

## 0.2.2

### Patch Changes

- 6f06a0b: Take the Qbit SDK from npm. `@qbit/pqc`, `@qbit/protocol` and `@qbit/api` are now the npm packages `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api` at exactly 0.1.0, published with provenance from the signed `v0.1.0` tags of Qbit-Org/qbit-pqc and Qbit-Org/qbit-js. Keys, addresses, descriptors, sighashes and signatures are unchanged. Through the new SDK the wallet refuses, before signing, a PSBT input that requests a sighash type other than `SIGHASH_DEFAULT`, a PSBT that pays an output qbit Core's restricted-output rule rejects, and a message with an unpaired UTF-16 surrogate. A finalized provider PSBT keeps the input fields qbit Core keeps, and one carrying another key's signature on the account's input now finalizes. P2MR message approvals and `verifyMessage` bind the proof to the expected address through `verifyP2mrMessageProof`'s new options, and only the canonical lowercase proof address verifies. A broadcast that `@qbit-oss/api` reports as `unknown_outcome` keeps its network, timeout, server or invalid-response reason and stays inconclusive; raw transaction bytes the client refuses make a fee bump `unverifiable`; and address-history reads pass twice the one-read budget, because the client reads an address again when its statistics move during the first read.

## 0.2.1

### Patch Changes

- Allow wallet listener callbacks to receive provider event arguments.

## 0.2.0

### Minor Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.
