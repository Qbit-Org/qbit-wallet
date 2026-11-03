---
'@qbit/preference-service': patch
---

Add two lock settings: `lockOnComputerLock` and `lockOnWindowsClosed`. Both are on by default, also for preferences stored before they existed, and a missing or malformed stored value reads as on. `getLockOnComputerLock`/`setLockOnComputerLock` and `getLockOnWindowsClosed`/`setLockOnWindowsClosed` read and save them; the setters resolve once the value is on disk and reject a failed save, as the other security settings do.
