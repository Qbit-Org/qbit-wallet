---
'@qbit/wallet-state': major
---

Remove the `useModelPopover` hook, the `accountActions.setModelPopover` action and the `molelsPopover` field of the accounts state, so `AppState['accounts']` no longer has it. Nothing called the hook or dispatched the action. Only the `ui` slice is persisted, so stored state is unaffected. The internal `getAddressUtxoDust` helper, which had no callers, is removed too.
