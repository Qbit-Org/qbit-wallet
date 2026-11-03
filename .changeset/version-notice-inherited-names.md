---
'@qbit/wallet-background': patch
---

`getVersionDetail` returns the empty notice for a version such as `constructor` or `__proto__`, a name that every object inherits, instead of throwing.
