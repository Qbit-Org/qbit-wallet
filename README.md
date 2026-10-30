# Qbit Wallet

Qbit Wallet is a browser extension and TypeScript toolkit for the independent
Qbit network. The workspace contains the extension, reusable wallet services,
Qbit transaction and signing utilities, and conformance tooling for Qbit Core.

## Workspace

This repository is a pnpm monorepo.

```text
apps/
└── extension              # Browser extension

packages/
├── approval-service       # User approval request lifecycle
├── base-utils             # Shared utility functions
├── contact-book           # Saved Qbit addresses
├── keyring-service        # Key management and signing
├── notification-service   # Local notification state
├── permission-service     # Connected-site permissions
├── phishing-detect        # Bundled site-safety policy
├── preference-service     # Wallet preferences
├── tx-helpers             # Transaction construction helpers
├── wallet-api             # Qbit API client
├── wallet-background      # Extension background runtime
├── wallet-connect         # Provider connection utilities
├── wallet-connect-react   # React provider bindings
├── wallet-core            # Address, transaction, and signing primitives
├── wallet-shared          # Shared contracts and utilities
├── wallet-state           # React and Redux wallet state
├── wallet-storage         # Persistence adapters
└── wallet-types           # Shared TypeScript types
```

The Qbit SDK comes from npm at exact versions: `@qbit-oss/protocol` and
`@qbit-oss/api` 0.1.1, published with provenance from the signed `v0.1.1` tag
of [Qbit-Org/qbit-js](https://github.com/Qbit-Org/qbit-js), and
`@qbit-oss/pqc` 0.1.1 from the signed `v0.1.1` tag of
[Qbit-Org/qbit-pqc](https://github.com/Qbit-Org/qbit-pqc).
`scripts/security/sdk-package-pins.json` pins each one (`pnpm sdk:packages:check`).

## Requirements

- Node.js 22.22.3 (see `.nvmrc`)
- pnpm 8.6.0

## Setup

```sh
pnpm install --frozen-lockfile
```

## Build and test

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm --filter qbit-extension build:chrome:mv3
```

The extension development build is available through:

```sh
pnpm --filter qbit-extension build:chrome:mv3:dev
```

## Qbit regtest

The local harness exposes Qbit Core and its indexed API through the
`regtest:*` scripts:

```sh
pnpm regtest:up
pnpm regtest:fund qbrt1... 1.0
pnpm regtest:mine 1
pnpm test:integration
pnpm regtest:down
```

Mining is explicit. Tests that require confirmations call `regtest:mine`
instead of relying on a timed block producer. See
[docs/regtest-harness.md](docs/regtest-harness.md) for ports, maturity rules,
environment overrides, and descriptor tooling.

## Documentation

- [Documentation index](docs/README.md)
- [Provider API](docs/api/README.md)
- [PQC derivation contract](docs/pqc-derivation.md)
- [P2MR transaction signing](docs/p2mr-psbt.md)
- [Security threat model](docs/threat-model.md)
- [Privacy and network behavior](docs/privacy.md)
- [Package release flow](docs/package-release.md)

## Development principles

- Keep Qbit consensus, address, serialization, and signing behavior covered by
  regression tests.
- Keep secret material inside keyring boundaries and require explicit user
  approval for signing and connected-site access.
- Keep package dependencies directional so the extension remains a thin
  integration layer.
- Keep network behavior documented and covered by source guards.

## Releases

Application releases use repository tags such as `extension/v0.1.0`.
Package publishing is documented separately in
[docs/package-release.md](docs/package-release.md).

## License

The repository is distributed under the licenses recorded in [LICENSE](LICENSE)
and the package-specific third-party notices. Those files retain the required
copyright and dependency attribution.
