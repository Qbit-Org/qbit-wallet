---
'@qbit/wallet-background': patch
---

A read of an account's outputs that was asked for before the wallet locked, was reset or had a wallet removed no longer keeps what it read for the balance, even when it only starts after a new unlock. Before, the send screen, a send or a send plan waiting on a request of its own could leave such a read of an over-limit account's history in memory, a removed account's included. Removing a wallet now also forgets what was read for it while the removal was under way. Reads still rank by when they started reading, so the send screen's own read after a failed shared read keeps its answer when nothing was cleared.
