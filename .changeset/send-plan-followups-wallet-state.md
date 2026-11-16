---
'@qbit/wallet-state': minor
---

Follow-ups to the send plan screens (#206).

`useQbitSendPlanScreenLogic` sends the shown view's `termsDigest` with Continue; when the background refuses it because the plan it stores states other terms, the screen says so (`send_plan_not_as_shown`), reads the plan again and shows what is stored, and never continues by itself. `useQbitSendPlan` orders the views of a plan by revision only within one run of the background (`backgroundId`), so after a restart a page shows what is stored whatever its revision, and reads a change another run announces. `WalletController.continueQbitSendPlan` takes the digest as its second argument.

`useTxCreateScreenLogic` holds Next after a `plan_open` answer only until the plan read it asks for lands: a plan in progress keeps the text and its link, and with none, or when the read fails, Next works again on the form as it is. `useQbitSendPlanReviewScreenLogic` does the same for Confirm, and confirms a restored-floor challenge with the background once for each challenge.

A `payment_fee_too_low` pause for which the background offers no raise says that the funds the payment uses cannot pay a higher fee (`send_plan_paused_payment_fee_too_low_not_raisable_body`), and the refusal `fee_not_raisable` has its text (`send_plan_fee_not_raisable`). When the fee has been raised as many times as a plan allows (`paymentFeeRaiseLimitReached`), the pause and the refusal `fee_raise_limit_reached` say that instead.
