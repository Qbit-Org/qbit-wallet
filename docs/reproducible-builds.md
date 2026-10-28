# Reproducible release builds

This repository produces a deterministic Chrome MV3 ZIP and checksum evidence. The
gate compares two clean extension builds byte for byte; it does not assert that a
build is safe merely because it is reproducible.

## Pinned inputs

- Node.js is exactly the version in `.nvmrc`.
- pnpm is exactly the `packageManager` version in `package.json`.
- JavaScript dependencies must come from `pnpm-lock.yaml` through
  `pnpm install --frozen-lockfile`.
- The PQC WebAssembly files come from the `@qbit-oss/pqc` npm package and are
  bound by the digests in `scripts/security/sdk-package-pins.json`
  (`pnpm sdk:packages:check`). Qbit-Org/qbit-pqc rebuilds them reproducibly
  from the digest-pinned Emscripten image in its `scripts/build-wasm.sh`.
- The Qbit SDK packages (`@qbit-oss/pqc`, `@qbit-oss/protocol`,
  `@qbit-oss/api`) must match their exact versions, registry integrity and
  provenance in `scripts/security/sdk-package-pins.json`; the repository has no
  Git submodules.

The extension packager sorts paths bytewise, omits directory entries, normalizes
file modes to `0644`, fixes ZIP timestamps at the DOS epoch, and writes:

- `qbit-chrome-mv3-v<VERSION>.zip`
- `qbit-chrome-mv3-v<VERSION>.zip.sha256`
- `qbit-chrome-mv3-v<VERSION>.zip.manifest.json`

The JSON manifest has no timestamp. It records the ZIP hash and size plus the
SHA-256 and size of every packaged file. Packaging fails for unsafe paths,
duplicate or unsorted entries, production source maps, source/test/environment
files, unexpected key material, a policy-drifting MV3 manifest, or PQC WASM that
does not match the package checksum and the pinned digest.

## Clean-machine two-build drill

Use a fresh private checkout on a supported Linux or macOS machine. Install the
exact Node.js version from `.nvmrc` and the system `unzip` command.

```sh
git clone git@github.com:Qbit-Org/qbit-wallet.git
cd qbit-wallet
test "$(node --version)" = "v$(cat .nvmrc)"
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm build:repro:extension
corepack pnpm sdk:packages:check
```

To rebuild the PQC WASM independently, run `pnpm check:wasm:repro` (Docker
required) in a checkout of Qbit-Org/qbit-pqc at the commit recorded in
`scripts/security/sdk-package-pins.json`, and compare its `wasm/SHA256SUMS`
with the pinned digests.

`build:repro:extension` rebuilds the required workspaces, removes only generated
extension output and build caches before each package build, and compares the
ZIP and both sidecars byte for byte. Successful output reports the common
SHA-256. Per-build evidence is retained under
`.context/reproducibility/extension/` and is intentionally ignored by Git.

For an already prepared workspace, the CI-equivalent command is:

```sh
corepack pnpm build:repro:extension -- --skip-prepare
```

A local diagnostic under a different Node patch may use
`--allow-toolchain-mismatch`, but that result is explicitly non-canonical and
cannot satisfy the release gate.

## Independent comparison

Two reviewers can run the clean-machine drill from the same reviewed commit and
compare the single line in each `.zip.sha256` file:

```sh
cmp reviewer-a/qbit-chrome-mv3-v<VERSION>.zip.sha256 \
  reviewer-b/qbit-chrome-mv3-v<VERSION>.zip.sha256
```

Before release, retain the reviewed commit ID, the SDK package pins, Node and
pnpm versions, ZIP SHA-256, JSON manifest SHA-256, commands, and CI run URLs.
Do not regenerate or substitute an artifact after that evidence is approved.
