---
'@qbit/wallet-state': patch
---

A page that loaded before the wallet existed now goes to the unlock screen when the wallet locks (#198): `AccountUpdater` asks at every lock whether a vault exists and marks it in the store (`isBooted`), and `useCreateAccountCallback` and `useRestoreQbitWalletCallback` mark it once they return, or once they fail with the wallet locked and a vault saved. Only a vault found is marked, never its absence, and a read that fails changes nothing.
