---
'@qbit/wallet-shared': minor
---

`BUS_METHODS.QBIT_SEND_PLANS_NOT_ENDED` (`qbitSendPlansNotEnded`) is announced to every wallet page once when a wallet removal completes and could not end all of the removed wallet's send plans (#216). Its parameters are `{ plans, unreadable, storeUnavailable }`: two counts and a flag, and nothing of the plans.
