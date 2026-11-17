---
'@qbit/wallet-state': minor
---

`ToolsContextType.toastWarning(content, options?)` takes `ToastOptions`, now exported: `{ lasting: true }` asks for a warning that stays long enough to read, can be closed and is announced as an alert, which the notice of a wallet removal that could not cancel a payment uses (#216).

`useQbitSendPlan` goes on reading a completed plan until its payment has confirmed, so a page shows the transaction the plan names after it changes and a plan that is paused again (#217). `useQbitSendPlan({ enabled })` reads nothing while `enabled` is false (the default is true), which a success screen opened for no plan uses. `useTxSuccessScreenLogic` follows the send plan its route names: it shows and links the transaction that plan names, replaces itself with the plan screen once the plan is no longer completed, and then sends no dismiss.
