---
'@qbit/wallet-connect-react': patch
---

A page that reconnects its stored wallet on load keeps that wallet when Qbit Wallet cannot answer: when the connection to it drops before it answers (EIP-1193 Disconnected, code `4900`), or when it is still starting and did not run the request (Resource unavailable, code `-32002`), so the next page load reconnects it. Any other error still forgets the stored wallet, as before.
