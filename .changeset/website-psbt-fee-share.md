---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
'@qbit/wallet-state': patch
---

Website PSBT approvals (signPsbt and signPsbts) also judge the fee by its share of what the transaction pays to others, without relying on the transaction's estimated size. A fee of at least 25% of that payout needs the approval's confirmation once it is also at least twice what the smallest send (one input paying one output, 3,817 vB) costs at the fastest recommended rate, with that rate counted as at most 100 bits/vB, even when the fee rate the approval shows looks normal. Without a live recommendation the relay floor of 1 bit/vB stands in for it, so a small website payment funded by two or more inputs can need the confirmation at a rate near that floor. When other parties fund some of the inputs, the fee is compared with what leaves the wallet: its inputs less the outputs paying it, the amount the approval shows. Only a PSBT where nothing but the fee leaves the wallet, such as a transfer back to it, has nothing to compare with and is judged by its rate alone.

A fee flagged only this way is titled a high fee rather than a high fee rate, behind the same confirmation, and a cold-wallet signer's request now carries that confirmation too. A website's sendQbit, whose PSBT the wallet builds itself, the send screen, the wallet's own send confirmation and fee bumps are judged as before.

The honest website PSBTs this newly asks to confirm are small payments whose fee is at least a quarter of the payout and that spend three or more inputs, or two inputs when change too small to keep is added to the fee or the rate is slightly above the recommendation (or the relay floor, when no live recommendation is available); and PSBTs that other parties help fund, including ones where the counterparty pays the fee, when that fee is at least a quarter of what the wallet pays.

`@qbit/wallet-shared` adds `QBIT_FEE_WARNING_SMALLEST_SEND_VSIZE`, an optional `checkFeeShareWithoutSize` on `assessQbitFee`, which reports such a fee as `large_share_of_amount` and marks one only that check flagged with `highFeeAtNormalRate` (without it the assessment is unchanged), `DecodePsbtOptions.suppliedByWebsite`, `isWebsiteSuppliedPsbt` and `psbtReviewOptions`. `summarizeQbitPsbtSpend` takes the same option. `decodePsbt` and `analyzeLocalPsbts` apply it to a PSBT a website supplied, which the sign screen and the batch analysis both tell from the request with `psbtReviewOptions`. `@qbit/wallet-state` titles such a fee with the new `high_fee_risk_title`.
