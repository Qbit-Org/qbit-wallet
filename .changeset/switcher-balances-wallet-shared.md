---
'@qbit/wallet-shared': minor
---

Add `QbitAccountTotal`: one account's total as the account switcher shows it, the address's confirmed and unconfirmed value together in sats (`totalBalance`), from the explorer's address statistics, so it costs one small request however many outputs the address holds. It names the network it is for (`chainType`) and when it was measured (`readAt`); `totalBalance` is `null` when no read has measured one, which is never the same as 0. `fresh` says the total is recent enough to show without reading it again, and is never `true` with no total; `error` says the latest read failed, and `totalBalance`, if any, is then the last one measured.
