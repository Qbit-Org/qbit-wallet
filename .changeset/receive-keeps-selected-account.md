---
'@qbit/wallet-background': patch
---

Keep the selected account when Receive opens (#139). `ensureQbitReceiveIntent` showed the wallet's latest receive intent and switched the selected account to the account that owns it, or, when that address had activity, issued the next address and switched to it. It now shows the selected account's own address and never changes the selection or issues another address. A used address stays current and is marked used. An exhausted address, a never-issued one past the restore gap, or an unused one that a recovery migration plan pays is not offered, and Receive offers New Address instead. An address reserved for a migration is also left out of the previous addresses. An unused address on screen becomes the ledger's current intent, which records it as issued the first time.

Only `createQbitReceiveIntent` (New Address) switches accounts. It saves the selection before it returns, since nothing re-selects the latest intent any more, and it rejects when the recheck finds activity on the address it just issued, instead of returning the unchanged state. `ensureQbitReceiveIntent`, `createQbitReceiveIntent` and `getQbitReceiveState` reject when another account or wallet is selected while they run, and New Address then does not switch accounts.
