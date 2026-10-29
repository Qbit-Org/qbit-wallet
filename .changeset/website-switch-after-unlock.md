---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
'@qbit/wallet-connect': patch
---

A website's `switchChain` or `switchNetwork` requested while the wallet is locked now asks the user to unlock first, and then shows the switch approval for the unlocked account, so the switch succeeds once the user approves it. Before, the approval was shown with the locked wallet's empty account, and after the unlock and approval the request failed with "Qbit provider context changed during approval". A switch still needs the user's approval, and an approval answered after the account or chain changed still fails. The SwitchNetwork approval screen now renders the network the website asked for; it read a field the request does not carry and failed to render. `chainForNetwork`, which maps a provider network name to its chain, is now exported by `@qbit/wallet-shared`, so the background and the approval screen share it.

In `@qbit/wallet-connect`, `QbitWallet.requestAccount()` now connects first with `requestAccounts()`, and only then, when the wallet is on another chain than the one the dapp is set up for, calls `switchChain()`. The user approves the switch as its own step, and the account returned is the one on the new chain, or none if the wallet has left that chain again. A `4100` from that `switchChain()` leads to one more `requestAccounts()` and a second switch only when the wallet's active chain changed after connecting; otherwise, as when the user disconnected the site during the approval, the `4100` is passed on. Before, it switched first, which a website that was not connected yet could not do, so the connection failed.
