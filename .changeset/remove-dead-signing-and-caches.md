---
'@qbit/keyring-service': major
'@qbit/wallet-background': major
'@qbit/preference-service': major
'@qbit/wallet-shared': major
'@qbit/wallet-state': major
'@qbit/base-utils': major
---

Remove code that nothing in the wallet uses, some of which carried hazards (#37).

- `@qbit/keyring-service` no longer exports `SimpleEncryptor`, which stored the vault and the password in clear text. `KeyringService` no longer has `signTransaction`, `signMessage` or `verifyMessage`, which signed and verified through a keyring of any type. P2MR signing stays on `signP2mrPsbtWithCounter` and `signP2mrMessageWithCounter`. A new wallet's boost value is now 32 random bytes from `crypto.getRandomValues`, not a creation timestamp. `QbitHdKeyring` always derives its seed with `mnemonicToSeedSync`.
- `@qbit/wallet-background` signs only P2MR. `signPsbtV2` refuses a request without P2MR signing keys, and `signMessage` refuses any type but `SignMessageType.P2MR`. The secp256k1 PSBT path is removed: `formatOptionsToSignInputs`, which signed every input when none matched the account, plus `formatPsbt`, `_signPsbt`, `signPsbt`, `getToSignData`, `createDummyPsbt` and `setPsbtSignNonSegwitEnable`. Also removed: the `uiRequestComponent` loop in the provider flow, `getEnableSignData` and `setEnableSignData`, `getAddressCacheBalance`, `getAddressCacheHistory`, and the unused `MAX_QBIT_FEE_RATE`. `getAddressSummary` and `getMultiAddressSummaries` now validate the explorer's statistics like every other statistics read, and read at most 8 addresses at a time.
- `@qbit/preference-service` drops the `balanceMap` and `historyMap` caches, which nothing read, and the `enableSignData` setting. It removes them from stored preferences on start, so the history of a removed wallet no longer stays in storage.
- `@qbit/wallet-shared`: `AddressSummary` replaces `totalSatoshis` and `spendableSatoshis` with `mempoolInclusiveSatoshis`, since the sum counts unconfirmed outputs and is not what can be spent. `COIN_DUST` is removed.
- `@qbit/wallet-state`: the `WalletContext` methods above are removed, and `useTxCreateScreenLogic` no longer returns `dustSats`. Its minimum amount is always the P2MR dust limit.
- `@qbit/base-utils` exports only `numUtils` (`satoshisToAmount`, `amountToSatoshis`), `paramsUtils` and `timeUtils.sleep`.
