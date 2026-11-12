---
'@qbit/phishing-detect': minor
---

`PhishingService.clearWhitelist()` forgets every navigation bypass, the session's and the stored ones, and stores an empty list. Unlike the list's other writes, it rejects when that write fails or when the service has not been initialised, so a wallet reset can tell that the bypasses are gone.
