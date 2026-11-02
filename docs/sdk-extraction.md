# qbit SDK Extraction

`@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api` are not owned by this
wallet repo. They live in the public `Qbit-Org` repositories so other qbit
wallets and applications can reuse them, and the wallet installs them from npm.

## Current Layout

```text
@qbit-oss/pqc 0.1.1       <- Qbit-Org/qbit-pqc, signed tag v0.1.1 (4164120)
@qbit-oss/protocol 0.1.1  <- Qbit-Org/qbit-js,  signed tag v0.1.1 (1cbf4b3)
@qbit-oss/api 0.1.1       <- Qbit-Org/qbit-js,  signed tag v0.1.1 (1cbf4b3)
```

Each package is an exact dependency (`"0.1.1"`, no range) of the wallet
packages that import it. Each was published with npm provenance by its
repository's `.github/workflows/publish.yml` from `refs/tags/v0.1.1`.
`scripts/security/sdk-package-pins.json` records each version, registry
integrity and provenance, plus the SHA-256 of `@qbit-oss/pqc`'s
`wasm/pqc.mjs` and `wasm/pqc.wasm` and of the qbit Core derivation and
signature fixtures it ships. `pnpm sdk:packages:check` fails unless the
lockfile resolves exactly one copy of each package at the pinned version and
integrity, every importer asks for that exact version, no other `@qbit-oss/*`
package is resolved without a pin, and the installed PQC WASM and fixtures
match the pin (and the WASM the package's `wasm/SHA256SUMS`).
`pnpm sdk:packages:check --attestations`, which the PQC workflow runs, also
fetches each version's attestations from the npm registry and fails unless
they name the pinned tarball digest, and the SLSA provenance names the pinned
repository, `publish.yml`, ref and commit.

The packages' own unit tests, PQC WASM reproducible rebuild and MV3 smoke run
in their repositories. Here, `pnpm test:pqc-golden` and
`pnpm test:protocol-vectors` run the wallet's golden vectors and the qbit
Core-derived derivation, signature, sighash and PSBT vectors against the
installed packages. The protocol vectors and their generators are vendored in
`scripts/conformance/qbit-js/`, because the npm tarball does not ship them.
`packages/keyring-service/test/fixtures/qbit-hd-keyring-vectors.json` pins the
pubkeys and addresses `QbitHdKeyring` derives from public BIP39 test
mnemonics, with and without a passphrase, on every network; its test runs
under `pnpm test`.

## Updating

1. Check the new tag is signed (GitHub reports the tag object as verified) and
   that the npm provenance names its repository, `publish.yml`, the tag ref and
   the tagged commit: `npm audit signatures` on an install of the new version,
   and `pnpm sdk:packages:check --attestations` once the pins are updated.
2. Change the exact version in every manifest that depends on the package and
   run `corepack pnpm install`.
3. Update `scripts/security/sdk-package-pins.json` from the published package:
   version, the lockfile integrity, the provenance commit, and for
   `@qbit-oss/pqc` the WASM digests after checking they match the tag's
   `wasm/SHA256SUMS`, and the fixture digests after reviewing any change to
   the fixtures.
4. For `@qbit-oss/protocol`, refresh `scripts/conformance/qbit-js/` from the
   provenance commit.
5. Update what else names the version:

   - the license records and lockfile digest in
     `scripts/security/dependency-license-baseline.json`
     (`node scripts/security/dependency-policy.mjs --write-license-baseline`,
     after checking each license);
   - the `qbitSdkPackages` identities in
     `scripts/conformance/fixtures/matrix.json`, once
     `node scripts/conformance/generate-matrix-fixture.mjs` derives the same
     addresses, descriptors and sizes. It reads the built keyring and
     wallet-shared, so run `corepack pnpm --filter "@qbit/keyring-service..." build`
     first;
   - the qbit-js references in `scripts/conformance/p2mr-v1-coverage.json`,
     then its SHA-256 in `provenance.coverageMap.sha256` of
     `scripts/conformance/fixtures/p2mr-offline.json`, and that fixture's
     `provenance.fixtureDigest.value` (`fixtureDigestValue` in
     `scripts/conformance/p2mr-offline-fixture-lib.mjs`), which
     `pnpm test:conformance:offline` checks;
   - and the docs.

   Build the extension (`pnpm build:repro:extension`): a module that newly
   reads `import.meta.url`, or calls `import.meta.resolve` with a specifier
   webpack cannot evaluate to a string, ships the builder's `file://` path
   and fails packaging until it is added to `RuntimeImportMetaUrlPlugin`'s
   `test` in
   `apps/extension/build/webpack.common.config.js` (see
   `docs/reproducible-builds.md`). Compare `hoistedLocations` in
   `node_modules/.modules.yaml` with a clean install of the base, so the bump
   moves no polyfill the extension bundles. Once the lockfile change is
   committed, regenerate the dependency evidence from a clean worktree
   (`corepack pnpm security:evidence`), copy the audited commit and the
   lockfile, audit and inventory SHA-256 it prints into the evidence table
   of `docs/security/dependency-review.md`, whose SDK row names the new
   version, and commit them.

The keyring vectors must pass unchanged. Do not regenerate them for an SDK
update: a different pubkey or address means the same seed would derive other
keys.

## Publish Path

All three SDK packages are on npm. The wallet's own workspace packages stay
private (see `docs/package-release.md`).
