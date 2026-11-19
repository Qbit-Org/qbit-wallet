---
'@qbit/wallet-shared': patch
---

Remove the `PLATFORM` and `REVIEW_URL` members of `PlatformEnv`, which nothing read, and the `RateUsStatus` type, whose preference `@qbit/preference-service` no longer has.
