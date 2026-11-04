---
'@qbit/approval-service': patch
---

Add `ApprovalService.assertNoPendingApproval()`, which refuses, as `requestApproval` would, while another approval is pending: it focuses that approval's window and throws "Another approval request is already pending". A request calls it before preparing what its approval would show (#152). It reserves nothing; `requestApproval` still checks and installs its approval with no await between, so of requests fired at once only one is shown.
