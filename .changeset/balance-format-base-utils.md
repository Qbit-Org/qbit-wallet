---
'@qbit/base-utils': minor
---

Add `numUtils.formatBalance(satoshis)`, which formats how much an account holds the way the wallet shows balances. The whole coins get a comma between groups of three digits, in every locale, and the amount shows five decimals, truncated and never rounded up, so it never shows more than the account holds: 11859183137906 satoshis is `118,591.83137`, 1999 is `0.00001` and 0 is `0.00000`. An amount above 0 and below 0.00001 is `<0.00001`, never zero. The answer gives the whole part, the five decimals, the text, the exact amount with all eight decimals and the same commas (`118,591.83137906`) for a hover text or a screen reader, and whether the text leaves out digits that are not zero.

It works with integers only, from a safe integer or a string of at most 40 digits without leading zeros, and gives `null` for anything else, such as a negative amount or any object, for the caller to show as unknown; a whole-number `BigNumber` can be passed as its digits, with `toFixed(0)`. It never throws. `satoshisToAmount` is unchanged, and amounts that are sent, compared or computed with keep using it.
