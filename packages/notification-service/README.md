# @qbit/notification-service

Local notification state for Qbit Wallet.

## Responsibilities

- Store wallet notifications.
- Mark notifications as read.
- Delete individual notifications or clear the list.
- Notify subscribers when local state changes.

## Usage

```ts
import { NotificationService } from '@qbit/notification-service'

const notifications = new NotificationService()
await notifications.init({ storage, api })
```

The caller controls persistence through the supplied store. Notification
payloads should not include secrets or signing material.

## Development

```sh
pnpm --filter @qbit/notification-service typecheck
pnpm --filter @qbit/notification-service test
pnpm --filter @qbit/notification-service build
```

## License

MIT
