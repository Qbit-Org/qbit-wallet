---
'@qbit/permission-service': patch
---

Stop a failed save of a site permission from undoing another change. `PermissionService` now saves changes to connected sites one at a time, in the order they were asked for, and each change starts from the sites the change before it left. A save that fails undoes only its own change: it no longer reconnects a site that was disconnected while it was pending, or brings back the sites a reset removed, until the background restarts. A connect or disconnect that was reported as failed is no longer applied after a restart because a later save stored it. A change shows in the service once every change asked for before it has been saved or undone, and a change to a site that is no longer there, such as pinning a site disconnected in the meantime, does nothing.
