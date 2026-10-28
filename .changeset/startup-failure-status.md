---
'@qbit/wallet-background': patch
'@qbit/wallet-state': patch
---

Tell the wallet's pages why background start-up failed, so they show an error screen instead of staying blank. When the stored settings cannot be read, start-up stops without writing defaults over them, but the only signal was `getBackgroundInited`, which stays false both while start-up runs and after it has stopped. `WalletController.getBackgroundStartupStatus` now returns `{ state: 'starting' }`, `{ state: 'ready' }` or `{ state: 'failed', reason }`, where `reason` is `'stored-settings-unreadable'` when the browser's storage could not be read and `'unknown'` for any other failure. `setBackgroundStartupFailed` records the reason, in memory only. `UI_CONTROLLER_METHODS` lists `getBackgroundStartupStatus` in place of `getBackgroundInited`, which the pages no longer call; the controller keeps both `getBackgroundInited` and `setBackgroundInited`. In `@qbit/wallet-state`, `WalletController` adds `getBackgroundStartupStatus`.

The extension's pages now ask for this status after a delay that doubles from 50 ms up to a second, and stop asking once start-up has finished or failed. On a failure they show a screen that says why and offers Retry, which restarts the extension so start-up runs again from the start, and writes nothing.
