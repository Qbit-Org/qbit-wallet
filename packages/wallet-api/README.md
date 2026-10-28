# @qbit/wallet-api

HTTP client and local service interfaces for Qbit Wallet.

## Responsibilities

- Apply Qbit API base URLs and request headers.
- Fetch wallet configuration and notification data.
- Expose utility endpoints used by the background runtime.
- Normalize service errors into stable wallet error types.

## Usage

```ts
import { HttpClient, WalletApiService } from '@qbit/wallet-api'

const endpoint = 'https://api.qbit.network'
const api = new WalletApiService()
await api.init({
  endpoint,
  httpClient: new HttpClient({ endpoint }),
  storage,
})
```

Use a trusted Qbit endpoint for `baseURL`. Callers should not forward seed
phrases, private keys, signing material, or decrypted vault contents to the API
client.

## Development

```sh
pnpm --filter @qbit/wallet-api typecheck
pnpm --filter @qbit/wallet-api test
pnpm --filter @qbit/wallet-api build
```

## License

MIT
