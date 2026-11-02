---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': major
'@qbit/wallet-state': patch
---

Drop the code paths for a chain that is not a Qbit chain. Every chain the wallet can select is a Qbit chain, and `normalizeChainType` now accepts only a string that `CHAINS_MAP` defines as its own key. A stored or requested chain that names a property every object inherits, such as `constructor`, `__proto__` or `toString`, and a value that is not a string but converts to a chain name, such as an array (`['QBIT_REGTEST']`) or a String object, now normalize to Qbit Mainnet like any other unknown value, through `normalizeChainType` and `normalizeAvailableChainType` alike, instead of passing through as a chain. `PreferenceService` therefore loads such a stored chain as Qbit Mainnet, so a stored `['QBIT_REGTEST']` can no longer select the local regtest endpoint at startup without the background's regtest check.

Breaking change in `@qbit/wallet-shared`: `COIN_DUST` is removed. The send screen's dust limit is `QBIT_P2MR_DUST`.

In `@qbit/wallet-background`, the `WalletController` methods that refused a chain that is not a Qbit chain no longer check for one: the history, raw transaction and lifecycle reads, the restore floor scan, recovery migration, receive and consolidation. The checks of a chain that a request names, in send claims, broadcast identities, external signing locks and fee bumps, stay. `restoreQbitKeyringWithFloors` refuses an address type other than P2MR, and `getQbitConsolidationStatus` refuses an account without a P2MR script. `signPsbtV2` always checks a PSBT's inputs against the send guards before it signs. `createKeyringWithColdWallet` and `deriveAccountsFromXpub` refuse with `hardware_wallet_not_supported` without reading their arguments, as they already did on every Qbit chain (#53); a stored cold-wallet keyring still loads. `wallet-background` no longer imports `bitcore-lib`.

In `@qbit/wallet-state`, `useTxCreateScreenLogic` always applies `QBIT_P2MR_DUST` and the relay fee floor, and treats an account with a P2MR script as a P2MR send; `useFeeRateBarLogic` always keeps a typed rate above `QBIT_MAX_FEE_RATE` for the send screen to refuse.
