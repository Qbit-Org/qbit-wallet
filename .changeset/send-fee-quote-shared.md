---
'@qbit/wallet-state': patch
---

Read the send screen's fee quote once and use it for both the fee bar and the abnormal-fee check, so the rates the fee bar offers and the rate the warning compares against can no longer come from two different quotes. `useTxCreateScreenLogic` returns the quote it reads as `feeQuote`, and `useFeeRateBarLogic` takes it as an optional `quote`: given one, the fee bar reads no quote of its own and offers that quote's rates in the same render in which the screen checks the fee against it. Without one, the fee bar reads its own quote as before. Until the selected rate has caught up with a newer quote, the send screen shows the total without judging the fee against that quote. Low-fee mode now puts its slow rate into a new list instead of changing the quote's own.

While a quote loads, the fee bar keeps the options and the rate it already had instead of falling to a default rate of 1 sat/vB. A fee quote that cannot be read now sets `feeEstimateUnavailable` and the relay floor as the rate, so the bar says which rate it uses, and a failed low-fee read falls back to the quote's own rates; neither leaves an unhandled rejection. `supportLowFeeMode` is now true only when low-fee mode applies to a loaded quote, so a Custom rate below 1 sat/vB is no longer accepted before a quote arrives.
