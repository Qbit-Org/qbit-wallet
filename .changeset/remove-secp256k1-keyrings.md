---
'@qbit/keyring-service': major
'@qbit/wallet-background': major
'@qbit/wallet-core': major
'@qbit/wallet-shared': major
'@qbit/wallet-state': major
---

Remove the secp256k1 keyrings and the code only they used (#37). Nothing in the wallet created them: create, restore and migration make only `QbitHdKeyring`.

- `@qbit/keyring-service` drops `HdKeyring`, `SimpleKeyring`, `importPrivateKey` and `deriveContextHash`, and no longer depends on `bitcore-lib`. A vault entry of either removed type still unlocks, as an `UnsupportedKeyring` that keeps its data and lists as "Unsupported Wallet". `createKeyringWithMnemonics` refuses any address type but P2MR. `changeAddressType` changes only the address type, since no keyring left changes its HD path with it.
- `@qbit/wallet-background` drops `getPrivateKey`, `createKeyringWithColdWallet`, `deriveAccountsFromXpub` and `deriveContextHash`. `createKeyringWithMnemonics`, `createTmpKeyringWithMnemonics` and `createTmpKeyringWithMnemonics2` refuse any address type but P2MR. `ColdWalletKeyring` stays, so vaults that hold one still load.
- `@qbit/wallet-core`: `isValidAddress` accepts only P2MR addresses, since qbit consensus refuses any other output type. Removed: the `message` module (ECDSA and BIP-322 signing), `toXOnly`, `tweakSigner`, `validator`, `schnorrValidator`, `UTXO_DUST` and the `dust` field of `decodeAddress`. The secp256k1 stack readonly wallets need to derive addresses stays.
- `@qbit/wallet-shared`: `KeyringType.HdKeyring`, `KeyringType.SimpleKeyring`, `KEYRING_CLASS`, `KEYRING_TYPE_TEXT`, `DummyTxType` and the `ECDSA` and `BIP322_SIMPLE` message types are removed.
- `@qbit/wallet-state`: `useExportPrivateKeyScreenLogic` and `useCreateColdWalletCallback` are removed. `useSignPsbtLogic` and `useSignMessageLogic` no longer have a cold-wallet signing step.

The `@qbit/tx-helpers` package is deleted. Its `UnspentOutput` type is replaced by the one in `@qbit/wallet-shared`.
