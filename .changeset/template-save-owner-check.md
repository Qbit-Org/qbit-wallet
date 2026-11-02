---
'@qbit/wallet-storage': patch
---

Check that a persistent proxy still owns its key before the first template write, not only before a retry. When a newer proxy for the same key, for example one created by a reset, takes the key while the older proxy is still reading, the older proxy writes no template and `createPersistentProxy` rejects with `A newer store replaced <key>; not saved`, so the template never replaces data the newer proxy saved.
