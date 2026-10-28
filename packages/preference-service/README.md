# @qbit/preference-service

Persistent wallet preferences for Qbit applications.

## Responsibilities

- Store the selected Qbit network and account.
- Manage account labels, address types, locale, currency unit, and lock timing.
- Store contacts and local wallet display settings.
- Serialize preference state through a caller-provided storage adapter.
- Publish preference updates to subscribed consumers.

## Usage

```ts
import { PreferenceService } from '@qbit/preference-service'

const preferences = new PreferenceService()
await preferences.init({
  storage,
})
```

The storage and keyring dependencies should be trusted application services.
Preference data must not contain seed phrases or private keys.

## Development

```sh
pnpm --filter @qbit/preference-service typecheck
pnpm --filter @qbit/preference-service test
pnpm --filter @qbit/preference-service build
```

## License

MIT
