---
'@qbit/wallet-state': patch
---

Fill every field that a saved `ui` state lacks when the wallet loads it. The `updateVersion` handler now gives the state saved by an earlier build each field of the current initial state that it is missing, at every depth, and keeps the values it saved. Before, a saved state without `addressInput` or `amountInput` made `updateAddressInput` or `updateAmountInput` throw, and a fee bar or send screen missing some fields stayed incomplete. Releases 1.0.5 to 1.0.7 start every new state with both fields, but kept a state that an earlier build saved without them as it was. A field that should hold an object but holds something else is replaced with its initial value, and a saved state that is not an object loads as the initial state.
