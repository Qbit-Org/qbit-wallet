---
'@qbit/wallet-storage': patch
---

Check that a persistent proxy still owns its key before the first template write, not only before a retry. When a newer proxy for the same key, for example one created by a reset, takes the key while the older proxy is still reading, the older proxy writes no template and `createPersistentProxy` rejects with `A newer store replaced <key>; not saved`, so the template never replaces data the newer proxy saved.

`createPersistentProxy` also rejects with the same error when a newer proxy took the key while the older proxy's read returned stored data, or while its template write was running, instead of returning a proxy that would never save.

When a proxy fails and hands the key back, it now passes over earlier proxies that rejected, which no caller holds. A proxy that was already returned gets the key and saves its unsaved changes. A proxy still being created gets the key without saving, so its data, not yet read, is never written over the stored data.
