---
'@qbit/wallet-background': minor
'@qbit/wallet-shared': major
'@qbit/wallet-state': major
---

Quick multi-sign of a local (non-provider) batch now runs the abnormal-fee and unrecognised-output checks of a single approval, and needs the same explicit confirmation before it signs a flagged PSBT (#367). `analyzeLocalPsbts(toSignDatas)` reviews each PSBT from its exact bytes, for the current account and fee quote and with the recipients its own request names, and returns its `risks` (`HIGH_FEE_RATE`, `UNRECOGNISED_OUTPUT`) and `spendSummary`, with the `account` and `chain` the batch was analyzed for. It refuses to answer when the current account or network changes while it reads them. The new `signLocalBatchPsbt(toSignData, review)` (`LocalPsbtBatchReview`) reviews the PSBT's bytes again before it signs them, and refuses a provider request, a recovery migration, a PSBT that does not decode, an account or network other than the one in `review`, a critical risk, and any risk not in `review.confirmedRisks`. Breaking change: `PsbtLocalInfo.risks`, `LocalPsbtSummary.account` and `LocalPsbtSummary.chain` are required.

`@qbit/wallet-shared` exports `LocalPsbtBatchReview` and `statedPsbtRecipients`, which moves there from `@qbit/wallet-state`'s `useSignPsbtLogic` module so the background reads a request's named recipients the same way.

In `@qbit/wallet-state`, `WalletController` adds `signLocalBatchPsbt`. `useSignPsbtLogic` analyzes the batch again when the account changes, ignores a late analysis for an earlier account, shows only an analysis for the current account, and analyzes the batch again when quick-signing. A flagged batch opens a review (`batchRiskReview`, with the flagged PSBTs in `batchRiskIndexes`) instead of signing; `onBatchRiskConfirm` signs the batch once, passing each PSBT's confirmed risks, and `onBatchRiskClose` signs nothing; an account switch closes the review. Quick-sign skips the PSBTs already signed, so a retry after a refusal signs only what is left. A batch analyzed for another account is refused.
