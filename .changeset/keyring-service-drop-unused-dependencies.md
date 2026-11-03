---
'@qbit/keyring-service': patch
---

`browser-passworder` and `patch-package` are no longer dependencies. Nothing imported `browser-passworder` at runtime: the vault-migration tests used it to build earlier-format fixtures, which they now build with `@metamask/browser-passworder` and check against a field that `browser-passworder` 2.0.3 wrote. `patch-package` was unused because pnpm applies the workspace patches itself. The package's runtime code does not change.
