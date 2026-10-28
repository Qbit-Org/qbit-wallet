# qbit Core Conformance Playbook

The default regtest harness installs qbit Core release binaries from
`Qbit-Org/qbit` at tag `v1.0.0` (commit
`7ebcddb622d6e639041f005a189b048ec2a221fe`). Committed conformance fixtures
are generated from, or byte-verified against, that same v1.0.0 source. The
manifest records the fixture source, source baseline and runtime release
separately, pins both Linux release-archive digests, hashes narrow
behavior-defining files, and hashes both the complete runtime source checkout and its `src` subtree, including Git entry modes and
types. CI verifies the release tag and `SHA256SUMS` under the pinned release
signer, derives the source commit from that tag, and builds qbitd from the
signed archive. It does not trust a mutable image tag or a caller-supplied
source label.

## Pinned mainnet launch values

The immutable [v1.0.0 release](https://github.com/Qbit-Org/qbit/releases/tag/v1.0.0)
uses a signed annotated tag whose target is
[`7ebcddb622d6e639041f005a189b048ec2a221fe`](https://github.com/Qbit-Org/qbit/commit/7ebcddb622d6e639041f005a189b048ec2a221fe).
The release tag and `SHA256SUMS.operator-01.asc` both verify under signing
subkey fingerprint `289EA3EC2F1939A24984840ED26CFC05586D371E`.
[qbit.org](https://qbit.org/) declares mainnet live, and its
[ecosystem directory](https://qbit.org/ecosystem) lists the community mainnet
explorer configured by the wallet.

The wallet pin bump revalidated these launch values against that source and an
isolated default-chain v1.0.0 runtime:

| Surface                    | v1.0.0 value                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Default chain / subversion | `main` / `/qbit:1.0.0/`                                                                                                |
| Genesis / `nBits`          | `0000000000004d60aa5d46013991d0a0e2995d89ee98e53068ae196d763e79f2` / `0x1a7f1ab5`                                      |
| Message start / P2P / RPC  | `44 4f 24 a8` / `8355` / `8352`                                                                                        |
| P2MR address / payment URI | Bech32m HRP `qb` / `qbit:`                                                                                             |
| AuxPoW chain ID            | `47`                                                                                                                   |
| DNS / archive fallbacks    | `flux-mainnet.qbit.org`, `phase-mainnet.qbit.org` / `positron-mainnet.qbit.org:8355`, `graviton-mainnet.qbit.org:8355` |
| ASERT anchors              | permissionless `0x18109c29`; AuxPoW `0x1801ca70`                                                                       |
| P2MR validation weight     | v2 accounting active from mainnet genesis                                                                              |
| Wallet gate / default      | `mainnetReady: true`; an absent or unknown chain selection resolves to `QBIT_MAINNET`                                  |
| API / explorer             | `https://mempool.qbit.org/api` / `https://mempool.qbit.org`                                                            |

The fee and dust review found no wallet constant change. Core retains a
3,681-byte maximum P2MR signature item, a 3,763-byte canonical single-key spend
estimate, `DUST_RELAY_TX_FEE=750` sat/kvB, and a 2,855-sat P2MR dust boundary.
The wallet retains exact one-input sizing of 3,817 vbytes for a default-hashtype
signature and 3,818 vbytes for the maximum explicit-hashtype item.

Override `QBIT_RELEASE` in CI or `QBITD_IMAGE` locally to test a different
release or candidate build. `scripts/conformance/core-pin.json` is the committed
baseline manifest used to map upstream source changes to affected matrix rows.

Use the regtest harness as the stable RPC target:

```sh
corepack pnpm regtest:up
QBIT_REGTEST_REQUIRED=1 corepack pnpm test:conformance
```

`test:conformance` runs seven live G2 rows serially against the node:

- deterministic derivation on receive and change branches (at least 20 indexes)
- descriptor import, Core listing, and parser/serializer round trips
- valid and invalid address parity through `validateaddress`
- TypeScript signing through `testmempoolaccept` and mined confirmation
- transaction size, fee, and dust-policy parity
- PSBT decode, combine, finalize, and cross-implementation finalization
- P2MR message-proof parity through Core `signdatapqchash` /
  `verifydatapqchash` and the qbit-js wallet proof verifier in both directions

The runner executes the available B4 Core-derived derivation, sighash, PSBT, and
signed-release P2MR offline fixtures before the live rows. `matrix.json` is a
separate committed wallet golden: its generator requires cryptographically
verified Core release provenance, validates its 20+20 addresses through Core
RPC, and the live suite independently checks the remaining
descriptor/address/signing/sizing/PSBT behavior. The additional offline fixture
is deliberately limited to commitment internals and fixed witness bytes that
the RPC rows cannot expose.

## Signed-release P2MR offline coverage

[`scripts/conformance/p2mr-v1-coverage.json`](../scripts/conformance/p2mr-v1-coverage.json)
maps all 78 cases in Core's `p2mr_v1_manifest.json` plus the current
`p2mr_datapqchash_vectors.json` case to the seven live rows, existing fixtures,
and package consumers. The audit found 25 offline-only gaps and rejected the
other 54 candidates as already covered or outside a wallet byte-generation
surface. The derivation, sighash, and PSBT fixtures it maps cite v1.0.0; the
sighash and PSBT fixtures are byte-identical to a `conformance:fixtures:core`
regeneration from the v1.0.0 checkout.

[`scripts/conformance/fixtures/p2mr-offline.json`](../scripts/conformance/fixtures/p2mr-offline.json)
contains only the surviving gaps:

- four valid and seven invalid P2MR commitment/control/root cases;
- two P2MR-vs-pinned-profile root cases;
- one explicit non-default witness, one annex witness, and three code-separator witnesses;
- the 128-node accepted and 129-node rejected control-path boundaries;
- five reserved/future leaf-version commitments and their consensus/policy outcomes.

The fixture binds the repository, signed release tag and target, release signer
and archive evidence, every source path, each Git blob ID and SHA-256, the
coverage-map digest, and generator name/version. Its fixture digest is not
self-referential: recursively sort object keys, preserve array order, omit only
`provenance.fixtureDigest.value`, serialize with whitespace-free
`JSON.stringify` as UTF-8, and SHA-256 the result. The package-backed consumer
recomputes leaf/branch hashes, roots, control blocks, scriptPubKeys, addresses,
sighashes, witness framing, and negative mutations:

```sh
corepack pnpm test:conformance:offline
```

Generation fails closed unless the checkout is clean, its exact GitHub origin
matches the pin, the annotated tag targets `HEAD`, the provenance object equals
the committed signed runtime release, all source paths are allowlisted regular
Git blobs, manifest hashes and case counts match, and the coverage map accounts
for every candidate exactly once.

Failures identify the matrix row, fixture, and compared field. Small values are
printed directly; private descriptors and large transaction/PSBT payloads are
redacted to their length and SHA-256 so diagnostics do not leak key material or
overwhelm CI logs.

Block production is on demand. Any conformance row that depends on mempool-to-confirmed state must mine at the assertion boundary:

```sh
corepack pnpm regtest:mine 1
```

There is no 60-second regtest ticker. Funding helpers handle the 1,000-block coinbase maturity before sending test funds.

## Candidate pin bump

Start by comparing a candidate source checkout with the committed baseline. The
report records the candidate commit and dirty state, maps each changed Core file
to the matrix rows that require review, and records expected/actual SHA-256. A
whole-checkout hash closes build-input gaps, a recursive `src` hash highlights
source drift, and narrow file hashes provide more specific row diagnostics. A
dirty checkout is always drift. The command exits nonzero on drift or missing
content:

```sh
corepack pnpm conformance:pin-report -- \
  --candidate-source /path/to/qbit \
  --output .context/qbit-pin-report.json
```

Exercise the no-op path against a clean checkout of the committed public runtime
source (comparing the manifest to itself is not evidence):

```sh
git clone https://github.com/Qbit-Org/qbit.git .context/qbit-core-pin
git -C .context/qbit-core-pin checkout --detach 7ebcddb622d6e639041f005a189b048ec2a221fe
corepack pnpm conformance:pin-report -- \
  --candidate-source .context/qbit-core-pin
```

Then exercise a candidate signed release. An arbitrary image or independent
source ref is useful for development, but it is not attributable release
evidence and the CI workflow rejects it:

1. Verify the annotated tag and signed checksum manifest. The command emits the
   deterministic provenance object consumed by matrix fixture generation:

   ```sh
   node scripts/conformance/verify-core-release-provenance.mjs \
     --source /path/to/clean-tag-checkout \
     --repository Qbit-Org/qbit \
     --release <candidate-release-tag> \
     --expected-commit <verified-tag-target> \
     --sha256-amd64 <signed-x86_64-archive-sha256> \
     --sha256-arm64 <signed-aarch64-archive-sha256> \
     --signer-fingerprint <trusted-release-signer-fingerprint> \
     --checksum-signature-asset <signed-checksum-signature-asset> \
     --output .context/qbit-release-provenance.json
   ```

2. Build and start the harness from the same release archive:

   ```sh
   QBIT_RELEASE=<candidate-release-tag> \
   QBIT_SOURCE_COMMIT=<verified-tag-target> \
   QBIT_ARCHIVE_SHA256_AMD64=<signed-x86_64-archive-sha256> \
   QBIT_ARCHIVE_SHA256_ARM64=<signed-aarch64-archive-sha256> \
   corepack pnpm regtest:reset

   QBIT_RELEASE=<candidate-release-tag> \
   QBIT_SOURCE_COMMIT=<verified-tag-target> \
   QBIT_ARCHIVE_SHA256_AMD64=<signed-x86_64-archive-sha256> \
   QBIT_ARCHIVE_SHA256_ARM64=<signed-aarch64-archive-sha256> \
   corepack pnpm regtest:up
   ```

3. Run conformance in required mode:

   ```sh
   QBIT_REGTEST_REQUIRED=1 corepack pnpm test:conformance
   ```

   For the mutating funding/indexer smoke, run:

   ```sh
   QBIT_REGTEST_REQUIRED=1 corepack pnpm test:integration:regtest-smoke
   ```

4. Regenerate every fixture named by `fixturesToRegenerate` in the report into a
   temporary candidate directory first. Each fixture's exact generator and
   consumer are recorded in `scripts/conformance/core-pin.json`. Review the diff
   by matrix row, fixture name, and field.

   The workflow automates the currently available Core-backed matrix, sighash,
   PSBT, and pinned offline regenerators and uploads the generated JSON, source
   report, and diffs as the `qbit-conformance-*` artifact. Matrix and offline
   fixture generation consume the verifier's signed-release evidence object; it
   does not accept independent repository, commit, and runtime labels.

5. Remap the signed release's complete P2MR manifest and message-proof corpus in
   `scripts/conformance/p2mr-v1-coverage.json`. Every added, removed, or changed
   source case needs a byte-level covered/uncovered decision. Regenerate the
   offline fixture twice from the same verified checkout, compare both outputs
   byte-for-byte, then review the committed diff:

   ```sh
   corepack pnpm conformance:fixtures:offline -- \
     --source /path/to/clean-tag-checkout \
     --core-provenance .context/qbit-release-provenance.json \
     --output /tmp/p2mr-offline-a.json
   corepack pnpm conformance:fixtures:offline -- \
     --source /path/to/clean-tag-checkout \
     --core-provenance .context/qbit-release-provenance.json \
     --output /tmp/p2mr-offline-b.json
   cmp /tmp/p2mr-offline-a.json /tmp/p2mr-offline-b.json
   git diff --no-index -- \
     scripts/conformance/fixtures/p2mr-offline.json \
     /tmp/p2mr-offline-a.json
   ```

   A `git diff --no-index` exit status of 1 means reviewable fixture drift, not
   tool failure. Do not overwrite the committed fixture until its provenance,
   coverage decisions, selected cases, digest, and byte changes have been
   reviewed.

6. Attach the pin report, conformance output, coverage-map diff, and every
   fixture diff to the bump review.
   Do not adopt a new pin without explicit sign-off for every changed consensus,
   descriptor, address, signing, sizing/dust, PSBT, or message-proof surface.

7. Update the baseline manifest, fixture provenance, docs, and CI image tags or
   digests together. Re-run the no-op self-check after committing the new
   baseline.

## CI cadence

The `qbit Core conformance` workflow runs nightly at the committed default pins,
with `QBIT_REGTEST_REQUIRED=1`; an unavailable backend is a failure, not a skip.
It verifies the signed source tag and checksum manifest, resets the chain, runs the
integration smoke, seven live conformance rows,
the qbit API smoke, and the wallet send-flow test, then tears the stack down.

For a candidate, use the workflow's **Run workflow** action. Supply
`qbit_release`, `qbit_archive_sha256_amd64`, and optionally the arm64 digest and
`electrs_qbit_image`. The workflow derives the source commit from the signed tag,
requires the configured archive digest to occur in the signed `SHA256SUMS`, and
records the locally built image ID and source-revision label. Explicit dispatch
inputs take precedence over repository variables.
A successful manual run is runtime evidence only: the source pin report, fixture
diff, and explicit surface-by-surface sign-off remain required.
