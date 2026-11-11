---
'@qbit/keyring-service': minor
---

Report and stop a P2MR PSBT signing (#171). `signP2mrPsbtWithCounter` takes an optional fifth argument, `{ onProgress, signal }` (`QbitP2mrSigningOptions`, now exported). `onProgress` (`QbitSigningProgressListener`) is called with `(signed, total, cached)`: with 0 once the checks pass, then after every input, a cached signature included, with `cached` counting the inputs whose signature came from the cache. It stops at an input that fails and reports nothing for a PSBT refused before signing. A listener that throws does not stop the signing. Once `signal` is aborted, the signing stops before its next input with `QbitSigningAbortedError` (`QBIT_SIGNING_ABORTED_CODE`); the inputs signed before keep their spent counters.
