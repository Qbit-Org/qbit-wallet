---
'@qbit/wallet-shared': major
---

Add `QbitSignatureBatchEntry` (`id`, `index` and the whole batch's `budget`) for the entries of a batch of PSBTs approved together (#152). `ToSignData.qbitSignatureBatch` replaces `qbitApprovedBatchDuplicate`, and `LocalPsbtSummary.signatureBatch` carries a local batch's id and budget.
