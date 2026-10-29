---
'@qbit/wallet-background': patch
'@qbit/wallet-state': patch
---

Tell the wallet's pages why background start-up failed, so they show an error screen instead of staying blank. When the stored settings cannot be read, start-up stops without writing defaults over them, but the only signal was `getBackgroundInited`, which stays false both while start-up runs and after it has stopped. `WalletController.getBackgroundStartupStatus` now returns `{ state: 'starting' }`, `{ state: 'ready' }` or `{ state: 'failed', reason }`, where `reason` is `'stored-settings-unreadable'` when the browser's storage could not be read and `'unknown'` for any other failure. `setBackgroundStartupFailed` records the reason, in memory only. In `@qbit/wallet-state`, `WalletController` adds `getBackgroundStartupStatus`. `getBackgroundInited` is removed from the UI port, `UI_CONTROLLER_METHODS` lists `getBackgroundStartupStatus` in its place, and `@qbit/wallet-state`'s `WalletController` interface no longer declares it; the controller itself keeps `getBackgroundInited` and `setBackgroundInited` for start-up.

The extension's pages now ask for this status after a delay that doubles from 50 ms up to 200 ms, and stop asking once start-up has finished or failed. On a failure they show a screen that says why, in English at once and in the page's language once it loads, and offers Retry, which restarts the extension so start-up runs again from the start, and writes nothing. Only reads made during start-up are classified; a read that fails later keeps its own error.
