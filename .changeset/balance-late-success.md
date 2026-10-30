---
'@qbit/wallet-state': patch
---

Keep a balance that arrives after a newer refresh failed. The balance card polls every 10 seconds without waiting for a slow refresh, and a newer refresh that failed first made the reducer drop the slower one's balance as stale, so a card with no balance yet kept showing the load error until a later poll succeeded. An older balance is now dropped only when a newer balance is stored: otherwise it is stored, the newer failure stays the latest outcome, and the card shows the balance as possibly out of date. `BalanceRefreshStatus` adds `balanceRequestId`, the refresh whose balance is stored.
