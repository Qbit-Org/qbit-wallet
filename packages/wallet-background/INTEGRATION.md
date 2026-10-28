# Wallet Background Integration Guide

`@qbit/wallet-background` provides the controllers, services, adapters, and
message-handling utilities used by Qbit Wallet's extension background runtime.

## Workspace use

```bash
pnpm --filter @qbit/wallet-background build
pnpm --filter @qbit/wallet-background test
```

The extension consumes workspace exports directly:

```typescript
import {
  keyringService,
  permissionService,
  phishingController,
  preferenceService,
  providerController,
  walletController,
} from '@qbit/wallet-background'
```

## Exported runtime

| Export | Responsibility |
| --- | --- |
| `walletController` | Qbit accounts, balances, transactions, signing, and network state |
| `providerController` | Page-provider request handling |
| `keyringService` | Vault, account, derivation, and signing state |
| `permissionService` | Connected-site permissions |
| `preferenceService` | Persisted wallet preferences |
| `phishingController` / `phishingDetectService` | Local website-safety classification |
| `approvalService` | Approval request lifecycle |
| `notificationService` | Extension notifications |
| `walletApiService` | Qbit API clients |
| `qbitPreparedSendReservationService` | Prepared-send reservation and broadcast coordination |

## Adapter system

The package exposes interfaces and extension implementations for:

- storage
- notifications
- network requests
- platform APIs

Initialize the concrete adapters before invoking controllers that persist or
load state. The extension startup path in
`apps/extension/src/background/init/restore.ts` is the reference composition.

## Testing

```bash
pnpm --filter @qbit/wallet-background test
pnpm --filter @qbit/wallet-background test:integration:send-flow
```

The regular suite uses mocks and memory-backed adapters. The send-flow
integration suite requires the Qbit regtest harness described in
`docs/regtest-harness.md`.

## Security boundaries

- Page-provider requests must pass the provider controller's origin,
  permission, parameter, and approval checks.
- Website-safety decisions are local and fail closed when a verdict cannot be
  established.
- P2MR signing goes through the Qbit signing path and its signature-counter
  reservations.
- New hardware-wallet keyrings remain disabled until the signer can produce
  Qbit SLH-DSA signatures.
