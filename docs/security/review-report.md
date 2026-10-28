# G4 internal security and reproducible-build review report

Status: internally actionable engineering review, 2026-07-24

This is not an external security review, legal opinion, release authorization,
or organizational sign-off. No reviewer was contacted, scheduled, sent
materials, or represented as having approved this work.

## Review target and outcome

- Main baseline: `c25ad3053f27750844350af00ef9ca03df7d1e37`, the merge
  commit for Playwright/E2E PR #148.
- Reviewed implementation/evidence head: `dfa0527`. The final report-only
  commit changes documentation, not build inputs.
- qbit-js submodule:
  `3a0f60e5c0b8b3b346c32e1a067068d0e41995ff`.
- qbit-pqc submodule:
  `b6ed7c271298de83696c7c2b14764ee85aa73a71`.

No open P0 or P1 finding remained after the isolated fixes below. The
internally actionable security tests, package policy, dependency controls,
CODEOWNERS, deterministic packaging, and read-only readiness check are in
place. This is not a statement that the wallet is ready to release: AR-02,
AR-03, AR-04, and AR-10 remain explicit human release gates, and the external
review brief still requires an authorized human decision.

## Findings and isolated fixes

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| F-01 | P1 | Provider sessions trusted page/tab metadata and could alias multiple documents in one tab. | `a6261d4` derives security origin from `MessageSender.url` and binds state to the exact runtime Port. |
| F-02 | P1 | Contradictory indexer transaction/output data could enter qbit spend modeling. | `f76614d` rejects mismatched txids, missing/contradictory outputs, and unsafe P2MR claims. |
| F-03 | P2 | MV3 execution and permission boundaries were broader than required. | `1484250` narrows hosts/resources/frames and codifies the reviewed CSP. |
| F-04 | P2 | Package contents and bundled PQC WASM had no explicit tamper gate. | `a30f6b5` validates the package inventory and committed WASM digest. |
| F-05 | P2 | ZIP metadata, ordering, and release hashes were not deterministic evidence. | `a4dce49` adds canonical ZIP construction, per-entry manifests, and a two-build comparison. |
| F-06 | P2 | Lock integrity, dependency sources, licenses, and Action provenance were not enforced together. | `f8bdd7a` adds one fail-closed policy and CI gate. |
| F-07 | P2 | Sensitive code lacked explicit CODEOWNERS coverage. | `df77968` covers custody, PQC/protocol, signing, approvals, manifests/build, and release workflows. Enforcement awaits AR-03. |
| F-08 | P1 | Persisted vaults used a 10,000-round PBKDF2 work factor. | `49a52b7` writes 900,000-round PBKDF2-SHA-256/AES-256-GCM metadata and atomically migrates an earlier-format vault after successful unlock. |
| F-09 | P2 | Webpack emitted CommonJS custody dependencies as URL assets, so the production MV3 worker could not start. | `1a9ab2b` bundles `.cjs` modules as code and rejects loose `.cjs` package entries. |
| F-10 | P3 | Recovery E2E evidence could sample extension/indexer state before convergence. | `dfa0527` waits for receive-page readiness and polls confirmed balances without weakening expected values. |

The accepted-risk register contains the attacker scenarios, owners, evidence,
dispositions, and release-blocking status for residual findings.

## Adversarial evidence

`corepack pnpm test:security-adversarial` passed 406 focused checks:

- 11 security-tooling checks, including a seeded `upstream` with another owner;
- 62 keyring checks for vault migration, plaintext leakage, counter
  crash/concurrency/retry/restore behavior, and restore gating;
- 204 wallet-background checks for provider origin/approval boundaries,
  display-versus-signed PSBT bytes, fee/UTXO lies, prepared-send reservation,
  and restore orchestration;
- 27 extension approval/messaging checks;
- 13 deterministic package, MV3, and WASM tamper checks;
- 76 malformed/contradictory qbit indexer API checks; and
- 13 PQC WASM loading, validation, and failure checks.

The full workspace build, typecheck, test suite, and committed PQC golden test
also passed after the last code/test commit. Expected negative-path logger
output and existing React `act(...)` warnings did not fail tests.

Playwright ran the production MV3 package against the pinned local qbit/electrs
regtest harness and passed 7/7 scenarios, including the merged PR #148 recovery
flow. The harness was stopped after evidence collection.

Core conformance passed:

- fixture smoke;
- all 7/7 live Core matrix rows;
- qbit API regtest smoke;
- TypeScript-to-Core P2MR sighash differential with a confirmed spend; and
- 3/3 production send/RBF integration tests.

Those Core/electrs runs validate the pinned behavior but used the currently
configured Qbit-Org executable images. They do not close custody gate AR-02.

PQC conformance passed the committed golden fixture, 45 qbit-pqc tests,
typecheck, committed WASM hash check, independent WASM rebuild, packed-tarball
MV3 service-worker vectors, and extension import smoke.

## Reproducible artifact evidence

A fresh detached worktree at `dfa0527` initialized the exact submodules and ran
a frozen install under Node 22.22.3 and pnpm 8.6.0. Two clean extension package
builds used `LC_ALL=C`, `TZ=UTC`, and `SOURCE_DATE_EPOCH=315532800`; the ZIP,
SHA-256 sidecar, and JSON manifest matched byte for byte. Packaging introduced
no tracked changes.

| Evidence | SHA-256 / value |
| --- | --- |
| `qbit-chrome-mv3-v0.1.0.zip` | `c30acfa503a9d88ccdf6b44d8640d01802ebaf9375990bea4f09f3d677c45116` |
| ZIP size | `2,883,768` bytes |
| JSON manifest file | `d54aedd66d4baca4a14f7809dc8c3f56b36d97fa2651e73fa85cd56f5ddd6e68` |
| committed `pqc.mjs` | `4c9f9d9d00dbf5608c10c674739bced4882701cdde3ee4c428214e8d20ee7c53` |
| committed/packaged `pqc.wasm` | `6a5142a702f96ec311099a90fb022415bb1504157ac3ba2ff84e973782ad41b0` |
| committed SLH-DSA golden fixture | `fca83f5ccfb500ece20dada0dc691cf7ffbd5dbfc54c3d5c46e67db33e916170` |

The repeatable clean-machine commands are:

```sh
test "$(node --version)" = "v$(cat .nvmrc)"
test "$(corepack pnpm --version)" = "8.6.0"
corepack pnpm install --frozen-lockfile
corepack pnpm build:repro:extension
corepack pnpm pqc:wasm:repro
```

This proves deterministic output for the reviewed inputs on the one canonical
builder used here. A separately authorized builder/operator must repeat it and
compare the hashes before release (AR-10).

## Dependency and license evidence

`corepack pnpm security:dependencies` passed against:

- 2,624 SHA-512-bound registry resolutions;
- 441 immutable dependency specifiers;
- 29 commit-pinned GitHub Action references; and
- 1,381 production license records.

The 2026-07-24 `corepack pnpm audit --prod --json` snapshot contained 112
vulnerable dependency occurrences: 4 critical, 50 high, 46 moderate, and 12
low, representing 97 unique advisories. The four critical records were traced
to build/development paths; their contextual dispositions and the MPL-2.0
notice/source-obligation gate are in `dependency-review.md`. This is not a
zero-advisory or legal-approval claim.

## Repository ownership and `upstream` control

At review time:

- root `origin` fetch and push were exactly the wallet repository's HTTPS
  URL;
- qbit-js and qbit-pqc submodule origins were exactly their corresponding
  repositories under the same owner;
- no root `upstream`, `remote.pushDefault`, branch remote, or URL rewrite was
  configured for this branch; and
- PR #148's merge commit was an ancestor of the review head.

The readiness checker examines every configured root and initialized-submodule
remote name, every fetch URL, and every push URL. GitHub HTTPS/SSH forms are
normalized, credentials are redacted, unrecognized URL forms fail closed, and
the owner must compare exactly (case-insensitively) with the wallet
repository's owner. The tooling test injects
`upstream=git@github.com:untrusted/qbit-wallet.git` and requires rejection.
Root `origin` has the additional requirement that it be exactly the wallet
repository.

This prevents a conventionally named `upstream` from silently targeting
another owner, but it cannot make an unprotected branch trustworthy by itself:
the checker and its workflow must be enforced through human-configured branch
protection/rulesets (AR-03).

The checker separately found eight executable-source references to Qbit-Org in
the Core/electrs pin, Dockerfiles, and workflows. These are not the wallet Git
remote or PR target, but strict readiness keeps them release-blocking. To close
AR-02:

1. mirror the exact signed Core tag, commit, checksum signature, and release
   assets to a private Core mirror, then independently compare hashes;
2. mirror the exact electrs commit to a private electrs mirror;
3. update the wallet pin, Dockerfiles, and workflows to those exact objects;
4. remove owner-selectable repository variables in favor of exact
   allowlists of those mirrors; and
5. rebuild both images, rerun Core/PQC conformance, and run strict
   `corepack pnpm release:readiness`.

Blindly renaming the repository strings is insufficient because the currently
pinned tag/assets/commits must exist and be independently verified at the new
destinations.

## Commands recorded

```sh
corepack pnpm test:security-adversarial
corepack pnpm security:dependencies
corepack pnpm release:readiness -- --report-only
corepack pnpm pqc:ci
corepack pnpm test:conformance
corepack pnpm test:integration:qbit-api
corepack pnpm test:integration:p2mr-differential
corepack pnpm test:integration:send-flow
corepack pnpm test:e2e
```

The full local CI-equivalent sequence was:

```sh
corepack pnpm -r --if-present --filter './packages/**' \
  --filter './external/**' --filter '!@qbit/wallet-background' run build
corepack pnpm --filter @qbit/wallet-background run build
corepack pnpm -r --if-present run typecheck
corepack pnpm -r --if-present test
corepack pnpm test:pqc-golden
```

## Explicit remaining gates

Release remains blocked pending all of the following:

1. private-mirror custody and hash/signature verification of executable
   Core/electrs inputs (AR-02);
2. human-configured `main` branch protection/rulesets enforcing required checks
   and CODEOWNERS, without this review changing GitHub settings (AR-03);
3. a current named-human dependency/advisory and third-party-license
   disposition (AR-04);
4. an authorized independent clean builder reproducing the exact artifact
   hashes (AR-10); and
5. an explicit human decision on external review using the unsent scope brief.

No merge, deployment, release publication, Chrome Web Store submission,
GitHub-setting change, external contact, or public proof-of-concept disclosure
was performed by this review.

## Addendum, 2026-10-19

This report is a dated record; apart from repository owner names, its body is
unchanged. Two of its dispositions have since changed:

- **AR-02 (external executable sources).** The mirroring plan above is
  withdrawn. qbit-wallet is becoming public, so executable Core/electrs inputs
  stay on the public `Qbit-Org/qbit` (signed `v1.0.0`
  release plus pinned archive hashes) and `Qbit-Org/qbit-electrs` (exact
  commit `5da0ce5f2da657dab6dd74b8108cb2b3e17da1e2`). `release:readiness` now
  enforces an exact allowlist of those two repositories, and no repository
  variable selects a source. See `docs/security/release-readiness.md`.
- **AR-03 (branch protection).** `main` is protected by ruleset 21680057 with
  one required approval and required CI checks. It does not require CODEOWNERS
  review and lets administrators bypass, so the gate stays open; readiness now
  reads rulesets instead of reporting protection as missing.

Addendum, 2026-10-23: the `main` ruleset has required CODEOWNERS review since
2026-10-21. AR-03 is now limited to the administrator bypass, which remains
in use; see `docs/security/accepted-risks.md`.

The evidence hashes in this report describe the reviewed commit. Current
values differ: the SLH-DSA golden fixture is now
`2666f212bd2170f5e6336c99c40c321b9469ad9532ae526fbf03d4f51f2839e1` (provenance
re-pointed to the public `Qbit-Org` PQC library, vectors unchanged), and the
packaged `pqc.wasm` follows `external/qbit-pqc/wasm/SHA256SUMS`.
