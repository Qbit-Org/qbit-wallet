---
'@qbit/keyring-service': patch
---

Unlock a vault that holds a keyring of a type this build does not ship. Unlocking used to throw `Unknown keyring type` and kept every wallet in the vault locked. Such an entry now loads as an inert `UnsupportedKeyring` placeholder: it keeps the entry's type and serialized data, so later vault writes carry them unchanged; it has no accounts; and it refuses every keyring operation. The wallet lists it as "Unsupported Wallet". An entry whose type is missing, empty or not a string still fails the unlock, and `addNewKeyring` and `createTmpKeyring` still refuse a type they do not know.
