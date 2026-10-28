# @qbit/wallet-shared

Shared contracts, constants, errors, and utilities for Qbit Wallet packages.

## Contents

- Account, address, history, transaction, and provider types
- Qbit network and platform constants
- Provider and wallet error codes
- Explorer, HD-path, URI, fee, and account-capability utilities

This package contains serializable contracts shared across process boundaries.
Changes to exported shapes should be validated in the extension background,
provider, and state packages.

## Development

```sh
pnpm --filter @qbit/wallet-shared typecheck
pnpm --filter @qbit/wallet-shared test
pnpm --filter @qbit/wallet-shared build
```

## License

MIT
