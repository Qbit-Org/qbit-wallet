---
'@qbit/keyring-service': patch
'@qbit/wallet-core': patch
---

Require 6.1.8 of the PSBT and transaction library, which fixes the critical advisory GHSA-8vv3-6qpc-gpw6 (CVE-2026-107846, a recurrence of CVE-2012-2459): its block merkle-root check accepted a transaction list padded with a duplicate transaction. The wallet never parses or checks a block, and no wallet code path changes. The library's PSBT code in 6.1.8 is byte-identical to 6.1.6's, and the workspace patch applies to it unchanged.
