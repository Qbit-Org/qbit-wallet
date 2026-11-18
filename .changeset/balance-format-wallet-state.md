---
'@qbit/wallet-state': minor
---

Balances show commas and five decimals. `useQbitDisplayLogic(balance)`, through which the home screen's balance card passes its total, Available and Unavailable, now gives the whole coins with commas and the point (`118,591.`), the five decimals, truncated (`83137`), and the exact amount with eight decimals (`exactAmount`, `118,591.83137906`) for the hover text and a screen reader. An amount above 0 and below 0.00001 is `<0.` and `00001`. The unknown placeholder `--`, or anything else that is not an amount, is shown as `--`, with no exact amount, and is never formatted as a number.

The Send screen's hooks return the same amounts as before: the Send screen still shows its Available, Unavailable, immature and pending amounts with all eight decimals, as the exact amount that Max fills and the fee check compares.
