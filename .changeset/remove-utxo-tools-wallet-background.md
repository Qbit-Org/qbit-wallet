---
'@qbit/wallet-background': patch
---

`getWalletConfig` no longer returns `disableUtxoTools`; the bundled configuration keeps `version`, `statusMessage` and `chainTip`.
