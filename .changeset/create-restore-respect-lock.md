---
'@qbit/wallet-state': patch
---

`useCreateAccountCallback` and `useRestoreQbitWalletCallback` mark the wallet unlocked only if the background still reports it unlocked once the create or restore returns, so a lock that came in meanwhile is not overwritten and the wallet is not shown unlocked over a locked background.
