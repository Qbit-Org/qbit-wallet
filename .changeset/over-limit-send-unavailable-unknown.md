---
'@qbit/wallet-state': patch
---

Show Unavailable as unknown on the send screen while Available is, for an account over the explorer's UTXO limit (#24). Until the send screen has read the account's outputs from its history (while that read runs, after it fails, and always for an account without a P2MR script), `useTxCreateScreenLogic` showed Available as `--` but Unavailable as the whole balance, taken from `unavailableBalance`, which equals the total while the split is unknown. It now returns `--` for `unavailableAmount` whenever it shows Available as `--`, with `showUnavailable` true, as the balance card does. Once the outputs are read, both rows show the amounts read, a measured 0 included.
