---
'@qbit/keyring-service': minor
---

`KeyringService.hasPersistedVault()` answers whether storage holds a vault, which is what the next start reads, where `hasVault()` answers from memory. A reset stores the erased state before it changes memory, so a reset that fails between the two leaves memory holding a vault that storage no longer has; the send plans ask storage after such a reset (#206).
