---
'@qbit/wallet-shared': minor
---

Add what a local signing's progress needs (#171): `QbitSigningProgress` (`progressId`, `signed`, `total`, `cached`), `QbitSigningOptions` (`progressId`), `BUS_EVENTS.toUIPort` for a message to one wallet page, `BUS_METHODS.QBIT_SIGNING_PROGRESS`, and `ErrorCodes.WALLET_LOCKED_DURING_SIGNING` (-18), with the message key `wallet_locked_during_signing`, for a signing that a lock stopped.
