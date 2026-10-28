# qbit Regtest Harness

This harness is the local backend for wallet and conformance tests. It runs qbit Core on regtest with P2MR-only policy enabled, plus an electrs-qbit HTTP/Electrum indexer.

## Requirements

- Docker with `docker compose`.
- For `qbitd`: nothing extra — the image installs verified release binaries from
  the public `Qbit-Org/qbit` GitHub release.
- For `electrs-qbit`: a source build of `Qbit-Org/qbit-electrs` (Rust toolchain
  is pulled during the image build) or a prebuilt image override.

By default the compose file builds the images locally and tags them as:

```sh
QBITD_IMAGE=qbit-wallet/qbitd-regtest:v1.0.0
ELECTRS_QBIT_IMAGE=qbit-wallet/electrs-qbit-regtest:5da0ce5f2da657dab6dd74b8108cb2b3e17da1e2
```

These are local-only tags. The electrs tag follows `ELECTRS_QBIT_REF`.
`qbitd` installs the upstream release binary (a few seconds); `electrs-qbit`
still compiles from source.

To skip the electrs source build, pull the public pinned image that the browser
release gate uses:

```sh
ELECTRS_QBIT_IMAGE=ghcr.io/qbit-org/electrs-qbit-regtest:5da0ce5f2da657dab6dd74b8108cb2b3e17da1e2@sha256:6299aeaa7d321effbabb76406ef5a275fb807b23e3e6d0c0b728a6a6bef593f0 \
ELECTRS_QBIT_PULL_POLICY=always \
corepack pnpm regtest:up
```

Override the release/refs or image names when testing a tagged release or a
candidate build:

```sh
QBIT_RELEASE=<qbit-release-tag> \
QBIT_SOURCE_COMMIT=<verified-release-tag-target> \
QBIT_ARCHIVE_SHA256_AMD64=<release-archive-sha256> \
QBIT_ARCHIVE_SHA256_ARM64=<release-archive-sha256> \
ELECTRS_QBIT_REF=<electrs-ref> \
corepack pnpm regtest:up

QBITD_IMAGE=<published-qbitd-image> \
ELECTRS_QBIT_IMAGE=<published-electrs-image> \
QBITD_PULL_POLICY=always \
ELECTRS_QBIT_PULL_POLICY=always \
corepack pnpm regtest:up
```

## CI images

The `Build regtest images` workflow
(`.github/workflows/build-regtest-images.yml`) publishes
`ghcr.io/<owner>/qbitd-regtest:<release>` and
`ghcr.io/<owner>/electrs-qbit-regtest:<ref>` on pushes to `main` that touch the
harness Docker context (or via manual dispatch). The build and conformance
workflows verify the annotated release tag and signed checksum manifest before
building qbitd from the pinned archive. This avoids treating a mutable image tag
or an independent source label as pin evidence. Local image overrides remain a
development convenience, but are not accepted as source-attributed CI evidence.

## Ports

- qbit RPC: `127.0.0.1:18452`
- qbit P2P: `127.0.0.1:18460`
- electrs-qbit HTTP: `127.0.0.1:3002`
- electrs-qbit Electrum: `127.0.0.1:60401`

These match the wallet's current regtest API default of `http://127.0.0.1:3002`.

## Extension Local Dev

The extension's `Qbit Regtest` chain entry points at `http://127.0.0.1:3002` by default. For local wallet testing:

1. Start the harness:

   ```sh
   corepack pnpm regtest:up
   ```

2. Build or load the extension dev bundle.
3. In the extension network settings, switch to `Qbit Regtest`. This is the current F7/local-dev path; future F7 settings work can add editable URLs, but the default already targets this harness.
4. Use `corepack pnpm regtest:fund <receive-address> <amount>` to fund addresses shown by the extension.

### Store flavor: optional loopback permission

The Chrome Web Store flavor (`build:chrome:mv3`, channel `store`) declares
`http://127.0.0.1:3002/*` only as an `optional_host_permissions` entry. Regtest
shows up as a locked **Local Regtest** row in Network settings, and Advanced
settings carries a **Local Regtest** row (On/Off) that opens an
Enabled/Disabled screen. Selecting the network row or **Enabled** walks
through the explanation, the acknowledgement checkbox, and Chrome's own
permission prompt; **Disabled** reverts to Mainnet and clears the in-app
consent. The browser grant itself stays until removed in Chrome's extension
settings: Chrome rejects `permissions.remove()` for this origin because the
`<all_urls>` content script makes it a required scriptable host. The E2E
flavor (`channel=e2e`) promotes the origin to a
required permission, so automation never sees the prompt or the explanation.

Before any regtest switch (and at startup when regtest was persisted) the
background verifies the harness identity with two read-only requests:

- `GET /block-height/0` must return, as `text/plain`, the Qbit regtest genesis
  hash `0ee96aa77c4b600850e349344fa21b107e805f5370ddc7a6189db12cf69acce6`.
  The route is exposed by the pinned `electrs-qbit` (`src/rest.rs`,
  `GET /block-height/:height`) and the hash is asserted in Qbit Core's
  `CRegTestParams` (`src/kernel/chainparams.cpp`) at the conformance-pinned
  release commit, so it identifies a Qbit regtest indexer and rejects an
  indexer for a different chain on the same port.
- `GET /blocks/tip/height` must return a block height, so an identity-only
  stub is not mistaken for a usable indexer.

A stopped harness yields **Qbit Wallet is unable to connect to your local Regtest
instance, check that it's running on port 3002.** (with a **Retry** action); anything else
on the port yields **Unexpected service at the Regtest address**. In both
cases the wallet stays on its previous public network.

Tests and manual flows that need confirmations must mine blocks explicitly:

```sh
corepack pnpm regtest:mine 1
```

Regtest has no public-chain 60-second block ticker. Confirmation-dependent assertions should call the mining helper at the point where they need a new block.

## Commands

```sh
corepack pnpm regtest:up
corepack pnpm regtest:cli getblockchaininfo
corepack pnpm regtest:mine 1
corepack pnpm regtest:fund qbrt1... 1.0
corepack pnpm regtest:dump-descriptors
corepack pnpm regtest:down
corepack pnpm regtest:reset
```

`regtest:fund <address> <amount>` creates or loads a Core funding wallet, reuses
its mature spendable balance when sufficient, and otherwise mines 1,001 blocks
to mature coinbase funds. It sends to the target address and mines one
confirmation block. This intentionally exercises Core's own P2MR wallet path
before test funds reach wallet-generated addresses without repeating an
expensive maturity window for every test row.

Coinbase maturity defaults to 1,000 blocks and can be overridden with `QBIT_REGTEST_COINBASE_MATURITY` only when testing a different Core policy.

## Environment Overrides

The scripts default to the compose harness, but can point at an existing node:

```sh
QBIT_REGTEST_RPC_HOST=127.0.0.1 \
QBIT_REGTEST_RPC_PORT=18452 \
QBIT_RPC_USER=qbit \
QBIT_RPC_PASSWORD=qbit \
corepack pnpm regtest:cli getblockchaininfo
```

Useful overrides:

- `QBIT_REGTEST_COMPOSE_FILE`: compose file path.
- `QBIT_REGTEST_CLI`: explicit `qbit-cli` binary.
- `QBIT_REGTEST_DOCKER_SERVICE`: qbitd compose service name, default `qbitd`.
- `QBIT_REGTEST_ELECTRS_DOCKER_SERVICE`: electrs compose service name, default `electrs-qbit`.
- `QBIT_REGTEST_CONTAINER_RPC_HOST` / `QBIT_REGTEST_CONTAINER_RPC_PORT`: RPC address used from inside the qbitd container when no local CLI is installed.
- `QBIT_REGTEST_ELECTRS_HTTP_URL`: electrs HTTP endpoint, default `http://127.0.0.1:3002`.
- `QBIT_REGTEST_WAIT_ELECTRS=0`: skip electrs readiness during `regtest:up`.
- `QBIT_FUNDING_WALLET`: Core wallet used for mining/funding, default `qbit-funding`.
- `QBIT_REGTEST_RPC_TIMEOUT_MS`: per-RPC conformance timeout, default 120,000 ms.

## Conformance Entry Points

`corepack pnpm test:conformance` checks that the RPC target is a regtest node,
then runs seven live qbit Core parity rows: receive/change derivation,
descriptor import/list round trips, valid and invalid addresses, signed-spend
acceptance and confirmation, transaction size/fee/dust behavior, PSBT
decode/combine/finalize interoperability, and P2MR message proofs signed and
verified across Core and qbit-js in both directions. Matrix failures name the row, fixture, compared
field, and redacted expected/actual diagnostics.

`corepack pnpm test:integration` remains the mutating backend smoke path.

By default these commands skip when the harness is not running. In CI or release gates, set:

```sh
QBIT_REGTEST_REQUIRED=1 corepack pnpm test:conformance
```

That turns an unavailable or wrong-chain harness into a failure.

For the mutating smoke path:

```sh
corepack pnpm test:integration:regtest-smoke
```

The smoke script loads the funding wallet, mines/funds through the shell helpers, waits for electrs to expose the funded UTXO, broadcasts a Core-built spend, mines one block, and checks the spend confirmation. It skips cleanly when the harness is unavailable unless `QBIT_REGTEST_REQUIRED=1` or `QBIT_REGTEST_SMOKE_REQUIRED=1` is set.

## Nightly and Candidate Pins

The `qbit Core conformance` GitHub Actions workflow runs nightly against the
committed default qbitd/electrs pins. Required mode turns missing services into a
hard failure. The job resets the volumes, runs the integration smoke, full
conformance matrix, qbit API smoke, and wallet send-flow test, and always tears
the services down.

Use **Run workflow** on that workflow for candidate testing. Set
`qbit_release`, its signed archive digest for the CI architecture, and optionally
`electrs_qbit_image`. The workflow checks out the signed release tag, verifies
the tag and `SHA256SUMS` under the pinned signer fingerprint, and derives the
source commit from that tag. It rejects arbitrary qbitd images and independent
source refs because neither provides the paired signer-authenticated source and
archive identities required by the workflow. This is release-operator
attestation, not a reproduced-build proof. Local Apple Silicon builds must set
the candidate arm64 digest; setting both architecture digests keeps commands
portable.

Before changing a pin, generate the source drift report:

```sh
corepack pnpm conformance:pin-report -- \
  --candidate-source /path/to/qbit \
  --output .context/qbit-pin-report.json
```

The report compares against `scripts/conformance/core-pin.json`, records dirty
candidate provenance, checks the complete Core checkout and `src` tree plus
narrow behavior files, maps changes to matrix rows/fixtures, and prints
expected/actual SHA-256.
Exercise the committed no-op drill with a clean checkout of the runtime commit:

```sh
git clone https://github.com/Qbit-Org/qbit.git .context/qbit-core-pin
git -C .context/qbit-core-pin checkout --detach 7ebcddb622d6e639041f005a189b048ec2a221fe
corepack pnpm conformance:pin-report -- \
  --candidate-source .context/qbit-core-pin
```

Regenerate affected fixtures, review named expected/actual byte diffs, and get
explicit sign-off for every affected surface before updating the manifest,
fixture provenance, documentation, and CI image pin together. See
[`conformance-playbook.md`](conformance-playbook.md) for the complete procedure.
