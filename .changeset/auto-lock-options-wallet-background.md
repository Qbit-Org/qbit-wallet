---
'@qbit/wallet-background': major
---

Breaking change: `WalletController.setAutoLockTimeId(timeId)` rejects with "Unknown auto-lock time" unless `timeId` is an auto-lock time offered now (`isAutoLockTimeId`, `@qbit/wallet-shared`); a retired id, a number no time has, a fractional number, `null`, `undefined` and a string are refused before anything changes, so the stored time and the running auto-lock time stay as they were. The auto-lock timer uses the time `getLockTimeInfo` resolves, so an unknown stored id gives the shortest time, 5 minutes, rather than the default.
