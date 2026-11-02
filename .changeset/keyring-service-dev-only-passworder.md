---
'@qbit/keyring-service': patch
---

`browser-passworder` is now a devDependency, used only by the test that builds an earlier-format vault fixture, and `patch-package` is no longer a devDependency, because pnpm applies the workspace patches itself. The package's runtime code does not change.
