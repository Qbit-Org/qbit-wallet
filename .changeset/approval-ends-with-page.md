---
'@qbit/approval-service': patch
'@qbit/wallet-background': patch
---

End a website approval with the page that asked for it. `ApprovalService.requestApproval` takes an optional third argument, `onPending(id)`, which receives the new approval's id before its window opens, so the caller can later reject that approval and no other. A provider request now carries the page it came from (`page: { signal, approvalIds }`): the request keeps the id of the approval it waits on in `approvalIds`, and the extension rejects those approvals and aborts `signal` when the page's provider port disconnects. A request whose page is gone stops before its approval is shown, and an approval that settles after the page went away is never acted on: the request checks the page after every approval and again right before the provider method runs, so nothing is signed or broadcast for it. A page that goes away while waiting for the wallet to unlock stops only its own request; the unlock request, which every waiting page shares, stays pending for the others. A request without a page behaves as before.
