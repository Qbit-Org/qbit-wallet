---
'@qbit/wallet-connect': minor
---

`QbitWallet.init` finds Qbit Wallet as soon as it is ready: it listens for the wallet's `qbit#initialized` and `qbit:announceProvider` events, asks for an announcement with `qbit:requestProvider`, and keeps polling `window.qbit` as before, for the same 5.5 seconds at most. An event only prompts another check of `window.qbit`, since a page can fake it, and the provider in an announcement is never used. The event names are exported as `QBIT_PROVIDER_INITIALIZED_EVENT`, `QBIT_ANNOUNCE_PROVIDER_EVENT` and `QBIT_REQUEST_PROVIDER_EVENT`.
