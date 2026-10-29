---
'@qbit/wallet-state': patch
---

Read the send screen's fee quote once and use it for both the fee bar and the abnormal-fee check, so the rates the fee bar offers and the rate the warning compares against can no longer come from two different quotes. `useTxCreateScreenLogic` returns the quote it reads as `feeQuote`, and `useFeeRateBarLogic` takes it as an optional `quote`: given one, the fee bar reads no quote of its own and offers that quote's rates in the same render in which the screen checks the fee against it. Without one, the fee bar reads its own quote as before. Low-fee mode now puts its slow rate into a new list instead of changing the quote's own.
