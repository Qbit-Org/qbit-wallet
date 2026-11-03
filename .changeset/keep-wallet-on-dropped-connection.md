---
'@qbit/wallet-connect-react': patch
---

A page that reconnects its stored wallet on load keeps that wallet when the connection to Qbit Wallet drops before it answers (EIP-1193 Disconnected, code `4900`), for example while the extension's background restarts, so the next page load reconnects it. Any other error still forgets the stored wallet, as before.
