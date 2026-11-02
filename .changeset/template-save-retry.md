---
'@qbit/wallet-storage': patch
---

Retry a failed save of a store's template instead of rejecting at once. When nothing is stored under a key, as for the settings on a first install, `createPersistentProxy` saves the template before it returns the proxy. 1.0.5 tried that write twice, because its fallback for a failed read wrote the template again. With that fallback gone, one failed write rejected, so `PreferenceService.init` failed and the extension's background did not finish starting until its service worker restarted. The template is now written up to three times, 100 and 200 ms apart, like a failed read, and the proxy rejects only when every attempt fails. Every attempt writes the same value, and a retry is skipped once a newer proxy owns the key, so the template cannot land after that proxy's writes. A reset saves its template the same way. A failed read still rejects without writing anything, and stored data is never replaced by the template.
