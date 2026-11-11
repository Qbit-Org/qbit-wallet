---
'@qbit/wallet-state': minor
---

`useWebsiteSafetyCheck()` and `useConnectWebsiteCheck()` accept a `clear` verdict with reason `trusted` and return `trusted`, which is true only while such a verdict is the current one; one that arrives after the check timed out does not count. `useSignMessageLogic()` and `useSignPsbtLogic()` return it as `isTrustedWebsite`. The extension's connect and signing screens show "Official Qbit website" for it, and a batch from that site can be signed at once without the per-site opt-in.
