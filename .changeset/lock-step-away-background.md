---
'@qbit/wallet-background': patch
---

Lock when you step away. `WalletController.lockOnSystemEvent('computer-locked' | 'windows-closed')` locks the wallet when that event's setting is on (`getLockOnComputerLock`, `getLockOnWindowsClosed` and their setters, also callable from the wallet's pages), and locks even while an unlock is still running, so the unlock ends locked. The auto-lock now also keeps a wall-clock deadline: a timer does not count the time the computer sleeps, so a screen action (`setLastActiveTime`) after the auto-lock time locks the wallet instead of extending the session. On the unlock screen an action only re-arms the time, as before. A broadcast already under way still settles after a lock.
