---
'@qbit/wallet-state': patch
---

`useSignPsbtLogic` signs each entry of a local batch, quick-signed or reviewed on its own, as a member of the batch the wallet opened for the reviewed approval, and returns `signatureBatchBudget`, the whole batch's signature budget, for the approval to show in place of each entry's own before and after figures, which depend on the signing order (#152).
