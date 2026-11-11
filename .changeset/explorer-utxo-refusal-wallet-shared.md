---
'@qbit/wallet-shared': major
---

`QbitConsolidationStatus` gains `overLimit`, whether the explorer refuses to list the account's outputs as it answered when asked, and its `outputLimit` becomes `number | null`: the limit the explorer's refusal states, the 500 the wallet assumes for an older explorer's bare HTTP 500, or `null` when the refusal states none and while the explorer lists the account (#169). `QbitConsolidationBatch.outputLimit` becomes `number | null` likewise.
