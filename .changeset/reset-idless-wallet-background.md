---
'@qbit/wallet-background': patch
---

A wallet page's `resetWallet` that names no wallet (no `walletId`, as a page that shows no wallet sends it) is judged too: while a wallet is booted it is refused with `WALLET_PAGE_OUT_OF_DATE`, on arrival and again where its job starts, so a reset queued behind another window's `boot` no longer erases the wallet that boot set up. While nothing is booted it still finishes a pending reset, or does nothing. Other calls that name no wallet, and calls that come through no page, are unchanged.
