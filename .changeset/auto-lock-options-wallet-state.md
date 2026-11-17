---
'@qbit/wallet-state': patch
---

`useLockTimePageLogic` returns, as `autoLockTimeId`, the offered time that the stored id resolves to (`resolveAutoLockTimeId`, `@qbit/wallet-shared`), so the Automatic Lock Time screen checks one of the six times also for a retired or unknown id. The settings slice starts at the new default, 30 minutes (id 5), as does a wallet reset.
