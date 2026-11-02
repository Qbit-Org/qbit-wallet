---
'@qbit/wallet-background': patch
---

A send screen no longer gets its outputs from a read that a replaced or evicted pending send has made stale. `getQbitUtxoSnapshot` shares a running read only with a screen whose address statistics read exactly as they did when that read started. A screen whose statistics show the history has got further still replaces the running read, and that read's screens get the new answer. A screen whose statistics differ any other way reads the outputs on its own: a pending send replaced with the counts unchanged, or evicted so that they drop, or an older answer from a lagging node. Until now such a screen joined the running read and could build a send on change that no longer existed, which the node refused after the signature was made. The running read carries on for its own screens, so a lagging node's answers still cannot keep restarting it.
