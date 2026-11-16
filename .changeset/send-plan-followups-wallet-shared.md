---
'@qbit/wallet-shared': minor
---

`QbitSendPlanView` gains two optional fields: `termsDigest`, the background's digest of the terms the view states, which a continue names, and `backgroundId`, the run of the background that made the view. `QBIT_SEND_PLAN_TERMS_DIGEST_PATTERN` and `QBIT_SEND_PLAN_NOT_AS_SHOWN_CODE` are exported with them. `QbitSendPlanPrepareRefusal` gains `fee_not_raisable`, for a raise of a payment's fee that cannot pay more over the funds it spends, and `fee_raise_limit_reached`, for a payment whose fee has been raised as many times as a plan allows, which the view says with the optional `paymentFeeRaiseLimitReached` (#206).
