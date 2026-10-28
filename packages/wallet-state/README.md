# @qbit/wallet-state

React contexts, Redux state, hooks, and screen logic for Qbit Wallet.

## State areas

- Accounts and keyrings
- Qbit transaction creation and history
- Network and wallet settings
- Navigation and view state
- Local UI preferences

The package communicates with the trusted wallet background through injected
context callbacks. Secret key material does not belong in Redux or persisted UI
state.

## Usage

```ts
import { createAppStore } from '@qbit/wallet-state'

const store = createAppStore()
```

## Development

```sh
pnpm --filter @qbit/wallet-state typecheck
pnpm --filter @qbit/wallet-state test
pnpm --filter @qbit/wallet-state build
```

## License

MIT
