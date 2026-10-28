# @qbit/wallet-core

Address, transaction, network, and message-signing primitives for Qbit Wallet.

## Exports

- `transactionCore` and its initialized elliptic-curve backend
- Qbit address conversion and validation helpers
- `toPsbtNetwork` and `toNetworkType`
- Signer tweaking and signature validators
- Message-signing helpers
- Transaction dust constants

## Usage

```ts
import {
  toNetworkType,
  toPsbtNetwork,
  transactionCore,
} from '@qbit/wallet-core'

const network = toPsbtNetwork('QBIT_MAINNET')
const networkType = toNetworkType(network)
const tx = transactionCore.Transaction.fromHex(serializedTransaction)
```

Network conversion functions are the package boundary for translating Qbit
network types into the transaction library's expected structure.

## Development

```sh
pnpm --filter @qbit/wallet-core typecheck
pnpm --filter @qbit/wallet-core test
pnpm --filter @qbit/wallet-core build:all
```

## License

MIT
