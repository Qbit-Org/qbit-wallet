# @qbit/phishing-detect

Deterministic website-safety checks for Qbit Wallet.

## Policy

- The denylist and its provenance metadata ship with the package.
- Matching uses normalized exact hostnames and subdomains.
- Approval checks classify an origin as `blocked`, `clear`, or `unverified`.
- Local navigation bypasses never turn an approval result into `clear`.
- Policy evaluation makes no network requests.

## Usage

```ts
import {
  LocalStorageAdapter,
  PhishingService,
} from '@qbit/phishing-detect'

const detector = new PhishingService()
await detector.init({
  adapter: new LocalStorageAdapter(),
  logger: console,
})

const verdict = detector.checkWebsite('https://example.com')
```

Use `checkWebsite()` for connected-site and signing approvals. It returns
`blocked` for an http(s) origin whose host the bundled denylist covers, even
when the origin is otherwise malformed or insecure (HTTP, a path, or a label
outside DNS syntax such as `a_b.<entry>`). Otherwise it validates the complete
origin and fails closed to an `unverified` verdict when an origin cannot be
evaluated safely.

`isDenylisted()` answers whether the bundled denylist covers a hostname,
ignoring navigation bypasses and DNS label syntax. The extension uses it to
withhold the wallet provider from denylisted pages, including ones the user
proceeded to. A DNR rule can name only a well-formed public hostname, so
validate a host before putting it in one.

`checkPhishing()` is intended for the extension's navigation warning. It
accepts a hostname and can honor explicit, locally stored user bypasses.
`addToWhitelist()` adds an in-memory bypass that covers the host and its
subdomains until the service is recreated, matching the extension's
session-scoped DNR `allow` rule for Proceed. Stored bypasses from
`addToPermanentWhitelist()` match the exact host only.

## Adapters

- `ExtensionAdapter` for browser-extension storage
- `LocalStorageAdapter` for web applications
- `MemoryAdapter` for tests
- `PhishingAdapter` for custom asynchronous storage

Adapters provide only `get` and `set`; they have no policy-fetching interface.

## Events

- `phishing:detected`
- `phishing:updated`
- `phishing:error`

## Development

```sh
pnpm --filter @qbit/phishing-detect test
pnpm --filter @qbit/phishing-detect build
```

The bundled source attribution is recorded in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

MIT
