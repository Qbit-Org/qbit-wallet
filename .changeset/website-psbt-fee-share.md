---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
---

Website PSBT approvals also judge the fee by its share of what the transaction pays to others, without relying on the transaction's estimated size. A fee of at least 25% of that payout needs the approval's confirmation once it is also at least twice what the smallest send (one input paying one output, 3,817 vB) costs at the fastest recommended rate, with that rate counted as at most 100 bits/vB, even when the fee rate the approval shows looks normal. Transfers back to the wallet, and PSBTs other parties help fund, have no payout to compare with and are judged by their rate alone, as before. The send screen, the wallet's own send confirmation and fee bumps are judged as before. The honest payments this newly asks to confirm are small website payments whose fee is at least a quarter of the payout and that spend three or more inputs, or two inputs when change too small to keep is added to the fee or the rate is slightly above the recommendation.

`@qbit/wallet-shared` adds `QBIT_FEE_WARNING_SMALLEST_SEND_VSIZE` and an optional `checkFeeShareWithoutSize` to `assessQbitFee`, which reports such a fee as `large_share_of_amount`; without it the assessment is unchanged. `summarizeQbitPsbtSpend` takes the same option, and `decodePsbt` sets it when the caller names a website, as `analyzeLocalPsbts` does for each PSBT a website requested.
