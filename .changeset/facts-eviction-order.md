---
'@qbit/wallet-background': patch
---

`QbitFundingTxReads` keeps its order of use as a list through the kept transactions, so pushing facts out never walks the cache; what is dropped, and when, is unchanged.
