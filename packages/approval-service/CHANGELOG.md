# @qbit/approval-service

## 2.1.0

### Minor Changes

- de81656: Add `ApprovalService.assertNoPendingApproval()`, which refuses, as `requestApproval` would, while another approval is pending: it focuses that approval's window and throws "Another approval request is already pending". A request calls it before preparing what its approval would show (#152). It reserves nothing; `requestApproval` still checks and installs its approval with no await between, so of requests fired at once only one is shown.

### Patch Changes

- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
- Updated dependencies [de81656]
  - @qbit/wallet-shared@3.0.0

## 2.0.2

### Patch Changes

- eb9f779: End a website approval with the page that asked for it. `ApprovalService.requestApproval` takes an optional third argument, `onPending(id)`, which receives the new approval's id before its window opens, so the caller can later reject that approval and no other. A provider request now carries the page it came from (`page: { signal, approvalIds }`): the request keeps the id of the approval it waits on in `approvalIds`, and the extension rejects those approvals and aborts `signal` when the page's provider port disconnects. A request whose page is gone before its provider method runs is never executed: it stops before its approval is shown, and the request checks the page after every approval and again right before the provider method starts, so an approval that settles after the page went away is never acted on. A provider method that is already running when the page goes away completes, since stopping it halfway could spend a signature without a broadcast or leave a broadcast's outcome unknown. Requests waiting for the wallet to unlock share one unlock request: a page that goes away stops only its own request, the unlock request stays open while another request still waits on it, and it is cancelled once no request waits, so its window no longer blocks other sites. A request without a page behaves as before.
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
- Updated dependencies [eb9f779]
  - @qbit/wallet-shared@2.0.1

## 2.0.1

### Patch Changes

- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
  - @qbit/wallet-shared@2.0.0

## 2.0.0

### Major Changes

- 6f06a0b: Bind each approval to an id, so that a window settles only the approval it rendered (#311). `ApprovalService.requestApproval` now gives every approval a random 128-bit id, and `getApproval()` returns `{ id, data }` instead of the bare data (`undefined` when none is pending). `resolveApproval(id, data?, forceReject?)` and `rejectApproval(id, err?, stay?, isInternal?)` take that id first. They settle the approval only while it is still the pending one, checking and settling in one step, and return `true`; for any other id they settle nothing, close no window, emit no event and return `false`. Previously a window that rendered approval A resolved or rejected approval B when B replaced A between the window's read and its answer, for example after a lock or unlock, a window close or a dapp retry. `openNotification(winProps?, approvalId?)` opens the window for `approvalId`, by default the pending approval. `handleWindowRemoved` now rejects only the approval its window was opened for and returns whether it did, and a window that finishes opening after its approval settled is closed instead of becoming the approval window. An approval whose window fails to open is now rejected with `ErrorCodes.UNKNOWN` (`Approval window failed to open`), and one whose window is closed before it finishes opening with `UserCancel`, instead of staying pending and refusing every later request as already pending. `Approval['data']` is now `ApprovalData`: either a provider request (`ProviderApprovalData`, whose `state` and `approvalType` are optional because the provider omits them) or the provider's unlock request (`UnlockApprovalData`, `{ lock: true }`). These types and `PendingApproval` are exported from the package root.

  The wallet controller's `getApproval`, `resolveApproval` and `rejectApproval` change the same way, and `resolveUnlockApproval` still resolves only the unlock request, in one step. In `wallet-state`, `WalletController` and `ApprovalContextType` take the approval id as the first argument of `resolveApproval` and `rejectApproval`, which now resolve to whether they settled it, and `getApproval` returns the new `PendingApproval`. `ApprovalContextType` accepts `undefined` from a screen that rendered no approval, which settles nothing. `SignPsbtProps` and `SignMessageProps` take an optional `approvalId`, the approval their default handlers settle.

  Breaking change: callers must pass the id from `getApproval` to settle an approval. A call with any other value, including the old `(data, forceReject)` and `(reason, stay)` arguments, is ignored.

### Patch Changes

- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/wallet-shared@1.2.0

## 1.1.5

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1

## 1.1.4

### Patch Changes

- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0

## 1.1.3

### Patch Changes

- Updated dependencies [a1458e0]
- Updated dependencies [f1bb656]
- Updated dependencies [b2a1b1a]
- Updated dependencies [688e9cb]
- Updated dependencies [213b242]
- Updated dependencies [3f39e95]
- Updated dependencies [a63aaf3]
- Updated dependencies [a25cee5]
- Updated dependencies [3c57bcf]
- Updated dependencies [64cc0ee]
- Updated dependencies [c83de12]
- Updated dependencies [917a499]
- Updated dependencies [0cd8709]
  - @qbit/wallet-shared@1.0.0

## 1.1.2

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.3.0

## 1.1.1

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.2.0

## 1.1.0

### Minor Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.

### Patch Changes

- Updated dependencies
  - @qbit/wallet-shared@0.1.3
