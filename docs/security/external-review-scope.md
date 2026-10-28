# External security review scope brief

Status: draft for an internal human decision. Not sent, scheduled, published,
or shared with any external party.

## Objective

Independently assess whether qbit-wallet preserves user-approved intent and
custody safety across classical/PQC signing, extension origin boundaries,
malicious network data, recovery, and the release supply chain.

The review target should be one immutable `Qbit-Org/qbit-wallet` commit plus
the `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api` npm releases
pinned in `scripts/security/sdk-package-pins.json` (with their `Qbit-Org`
source commits).
Any later change to signing, approval, vault, protocol, WASM, or packaging code
invalidates the affected review evidence.

## Requested expertise

- browser-extension MV3 isolation, messaging, CSP, and approval UX;
- Qbit PSBT/transaction intent validation and wallet coin selection;
- SLH-DSA/PQC implementation integration, bounded signature-budget custody,
  backup, and restore analysis;
- WebAssembly memory and loading behavior;
- password-based vault cryptography and migration safety; and
- reproducible builds, npm/GitHub Actions provenance, and release artifact
  review.

No reviewer or vendor has been selected or contacted.

## In-scope components

1. `packages/keyring-service`
   - vault format and password KDF;
   - mnemonic/private/PQC key lifecycle and memory handling;
   - classical and P2MR derivation/signing routes;
   - counter reservation, signature cache, crash recovery, concurrency, and
     mnemonic restoration.
2. `packages/wallet-background`
   - provider RPC admission and permission rechecks;
   - approval snapshots and display-versus-signed PSBT/message bytes;
   - qbit fee/UTXO/history modeling, send broadcast claims, and external
     signing locks;
   - restore discovery and counter-floor orchestration.
3. `apps/extension`
   - content/page/background trust boundaries and sender-derived origins;
   - MV3 permissions, web-accessible resources, CSP, network hosts, storage,
     and service-worker restart behavior;
   - packaged-file inventory, source-map/secret exclusion, and PQC WASM
     loading.
4. `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api`
   - only the pinned packages and wallet-facing interfaces;
   - qbit Core conformance assumptions and vectors.
5. Build/release controls
   - frozen dependency closure, Action pins, licenses, toolchain pins;
   - deterministic WASM/extension build and ZIP construction;
   - artifact manifests, SHA-256 comparison, CODEOWNERS, and release readiness.

## Priority questions

- Can any page/frame/document obtain another origin's session or approval?
- Can caller or indexer data cause the signer to receive transaction/message
  bytes materially different from the approval UI?
- Can a crash, retry, concurrent request, stale backup, or incomplete restore
  make PQC usage accounting unsafe or incorrectly open the signing gate?
- Are all secret-bearing storage writes encrypted, and is the planned vault
  KDF migration able to authenticate earlier vaults and update them atomically?
- Can remote/dynamic code, a tampered WASM, source map, unexpected package
  entry, mutable dependency, or alternate repository source enter a release?
- Do reproducibility claims survive a clean independent environment and exact
  artifact comparison?

## Expected evidence package

Provide only after an authorized human initiates the review:

- immutable repository/submodule commit IDs and a clean-source archive from the
  `Qbit-Org/qbit-wallet` repository;
- `docs/threat-model.md`, accepted-risk register, dependency review, and review
  report;
- exact commands and passing logs for adversarial, unit, E2E, PQC/Core
  conformance, packaging, and two-build comparison;
- extension ZIP, per-entry manifest, whole-ZIP SHA-256, and package inventory;
- current advisory snapshot and documented contextual dispositions; and
- synthetic test mnemonics/keys only.

Never provide production secrets, user wallets, organization tokens, signing
keys, unpublished proof-of-concept material, or access beyond the minimum
private review scope.

## Requested output

- findings with explicit severity, attacker prerequisites, affected paths and
  commits, violated invariant, impact, and reproducible evidence;
- a clear separation between exploitable issues, defense-in-depth, and
  unverifiable assumptions;
- confirmation of which supplied test/release claims were independently
  reproduced;
- remediation guidance and retest results; and
- unresolved assumptions or scope limitations.

The reviewer should not merge, deploy, publish, submit an extension, change
GitHub settings, or disclose findings without separate written authorization.

## Out of scope unless separately authorized

- production infrastructure penetration testing or denial-of-service;
- testing third-party indexers, GitHub, npm, browsers, or users;
- social engineering, credential attacks, or real-fund transactions;
- Chrome Web Store submission;
- consensus changes in repositories not included in the immutable target; and
- public disclosure or coordinated-disclosure outreach.

## Internal prerequisites before contact

- close or explicitly waive every release-blocking register entry;
- choose the immutable target and preserve its build artifacts;
- decide access method, reviewer identity, contractual/confidentiality terms,
  budget, schedule, disclosure policy, and internal owner;
- remove all real secrets and verify the synthetic evidence bundle; and
- obtain explicit current authorization to contact/share.
