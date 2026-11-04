---
'@qbit/wallet-background': patch
---

`ProviderRequestEnvelope`'s content `tabCheckin` params take an optional `topFrame` flag. The extension's content script, which now runs in every frame, sets it to say whether it checks in from the tab's top frame. The extension relies on it only for a page Chrome prerendered, whose top frame connects under a frameId other than 0, to decide which document is the tab's current site.
