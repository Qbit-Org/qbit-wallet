---
'@qbit/keyring-service': patch
---

`browser-passworder` and `patch-package` are no longer devDependencies. The vault-migration tests build their earlier-format fixtures with `@metamask/browser-passworder` and check them against a field that `browser-passworder` 2.0.3 wrote, and pnpm applies the workspace patches itself. The package's runtime code does not change.
