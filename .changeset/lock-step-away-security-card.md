---
'@qbit/wallet-state': patch
---

`useSecurityCardLogic` backs the two new Security switches, "Lock when the computer locks" and "Lock when all windows close": it reads both settings, saves one change at a time, and keeps a switch as it was when its change is not saved, with the same error messages as the other security settings. The `WalletController` interface gains the four lock-setting methods.
