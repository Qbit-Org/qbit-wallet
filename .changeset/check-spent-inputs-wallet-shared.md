---
'@qbit/wallet-shared': minor
---

`QbitSendPlanPauseReason` gains `input_check_mismatch`, `input_check_not_spendable`, `input_check_not_found` and `input_check_unchecked`: a send plan stopped before a signature because an input it would spend failed the check of its funding transaction, by cause (#210).

`QbitFeeBumpUnavailableReason` gains `inputs_not_spendable`: a fee bump is not offered when one of the inputs it would spend again is an output the wallet's signing refuses, read and checked against its funding transaction: someone else's unconfirmed payment to the account, or change from an unconfirmed transaction that also spent someone else's output (#210).
