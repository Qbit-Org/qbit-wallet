# @qbit/keyring-service

Key management and signing for Qbit Wallet.

## Responsibilities

- Create and restore HD wallets.
- Manage simple, readonly, watch-address, and cold-wallet accounts.
- Derive Qbit addresses for mainnet, testnet4, and regtest.
- Sign messages and Qbit transactions.
- Encrypt persisted keyring state through a caller-provided encryptor.
- Track post-quantum signing state and reject unsafe counter reuse.

## Install

This package is private to the qbit-wallet workspace and is not published to
npm. Other workspace packages depend on it as
`"@qbit/keyring-service": "workspace:*"`.

Do not install `@qbit/keyring-service` from a registry. This project does not
own the `@qbit` scope on npm (#289), so a package published there under this
name does not come from this repository.

## Usage

```ts
import {
  BrowserPassworderEncryptor,
  KeyringService,
} from '@qbit/keyring-service'

const keyrings = new KeyringService()

await keyrings.init({
  storage,
  encryptor: new BrowserPassworderEncryptor(),
})
await keyrings.boot('wallet password')
```

Applications should keep the service behind a trusted process boundary. Never
expose private keys, seed phrases, encrypted vault contents, or signing-state
counters to connected sites.

## Exports

- `KeyringService`
- `HdKeyring`
- `QbitHdKeyring`
- `SimpleKeyring`
- `ColdWalletKeyring`
- `BrowserPassworderEncryptor`
- `SimpleEncryptor`
- Public keyring and account types

The Qbit HD keyring is also available through the
`@qbit/keyring-service/qbit-hd-keyring` export.

## Development

```sh
pnpm --filter @qbit/keyring-service typecheck
pnpm --filter @qbit/keyring-service test
pnpm --filter @qbit/keyring-service build
```

## License

MIT
