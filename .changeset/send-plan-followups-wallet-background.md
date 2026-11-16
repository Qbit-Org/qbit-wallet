---
'@qbit/wallet-background': minor
---

Six follow-ups to the send plans from the review of #196 (#206).

`continueQbitSendPlan(planId, termsDigest)` now names what the page shows: every plan view carries `termsDigest`, the background's SHA-256 of the terms it states (the plan, its account and network, the recipient, the target, the amount, the change, the fee rate, the total fee, the signatures and every transaction's id, input count and fee), and `backgroundId`, which names the run of the background that made it, as every `QBIT_SEND_PLAN_CHANGED` announcement does too. The engine refuses a continue whose digest is not that of the record stored then, at the call and again in the write that resumes the plan, before anything is authorised, written, held or signed, with an error coded `QBIT_SEND_PLAN_NOT_AS_SHOWN`; anything but a digest in its exact form is a `TypeError`. The stored record's format is unchanged.

`resetAllData`, which no page can call and Reset Wallet does not use, erases the send guard's holds and the stored plans right after the keyring reset, before the preferences, and tells the engine the keys are gone (`keysErased`) or that the keyring reset threw (`keyringResetFailed`). Once the keys are gone the engine goes on only over a store known to hold no plan, tries the erase again every tick, and at start-up, whatever reset the wallet went through, erases stored plans when there is no vault. After a keyring reset that threw, whether the keys are gone is read from storage (`hasPersistedVault`), and the plans stay stopped while that cannot be read.

`endPlansOf` ends every readable plan of a removed wallet also when dropping an entry the store cannot read, or ending one plan, fails. It returns `QbitSendPlanEnding`, whose `notEnded` names what a refused write left; those accounts are held back, with nothing of them signed, broadcast or advanced, and ended again at every tick. A wallet reset waits for such an attempt. The holding back is kept in memory only.

`raise_payment_fee` is offered only when a fee rate a page can send, in hundredths of a bit/vB, builds a different payment over the same inputs that pays more than every version so far (`lowestQbitSendPlanPaymentRaiseRate`). A review asked for when none does is refused `fee_not_raisable`, and a rate whose fee does not rise is refused `fee_rate_too_low` with the lowest that does. Nor is it offered once the plan keeps as many earlier versions of its payment as it can (16): the view then carries `paymentFeeRaiseLimitReached`, and a review asked for anyway is refused `fee_raise_limit_reached` instead of throwing.

A plan completed by a transaction that is no version of its payment (`paidBy`) keeps looking its own payment up once its bytes left the wallet, and names it, with its fee, when it is the one that confirms.
