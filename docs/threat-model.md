# qbit-wallet threat model

Status: internal adversarial review, 2026-07-24

Baseline: `origin/main` at
`c25ad3053f27750844350af00ef9ca03df7d1e37`, including Playwright/E2E PR #148.
This document covers the wallet repository and its pinned Qbit SDK npm
packages (`@qbit-oss/pqc`, `@qbit-oss/protocol`, `@qbit-oss/api`).
It is not an external review, legal opinion, or organizational sign-off.

## Review method

### Severity

| Severity | Release meaning |
| --- | --- |
| P0 | Broad or imminent key/fund loss, unauthorized signing, practical PQC counter safety failure, or release supply-chain compromise with little or no user interaction. Stop release immediately. |
| P1 | A plausible attacker can cross a wallet trust boundary and cause targeted fund loss, sign bytes materially different from the approval, bypass origin/approval policy, expose custody secrets, reuse unsafe counter state, or execute unreviewed release code. Fix before release. |
| P2 | Material defense, privacy, integrity, or availability weakness with meaningful prerequisites or a compensating user/human control. Requires an explicit disposition and owner. |
| P3 | Hardening, evidence, documentation, or low-impact availability issue. Track; it does not independently stop release. |

### Evidence required for a finding

A finding needs:

1. an affected commit and exact code, configuration, or package path;
2. attacker prerequisites and the trust boundary crossed;
3. the violated security invariant and credible impact;
4. a deterministic test, minimal private reproduction, or exact artifact
   inspection;
5. for approval findings, the displayed intent and exact bytes submitted to
   the signer;
6. for PQC counter findings, the before/after persisted counter and crash,
   retry, or restore state; and
7. for release findings, input commits/tool versions, package file list,
   per-entry SHA-256, and whole-ZIP SHA-256.

Registry severity without reachability analysis is evidence, not by itself a
wallet severity. Conversely, an internal invariant violation may be P0/P1 even
when no registry advisory exists.

### Fix boundary

- Minimal qbit-wallet P0/P1 fixes belong in isolated security commits in this
  PR when they do not change protocol consensus or recovery semantics.
- Changes to qbit Core or qbit-electrs belong in separate PRs on the public
  `Qbit-Org` repositories, and changes to qbit-js or qbit-pqc in separate
  `Qbit-Org` PRs and signed releases, followed by reviewed pin updates here.
- Protocol migrations, new recovery trust models, repository visibility, GitHub
  branch-protection settings, release publication, and external review are
  human/organizational gates. This review may report or prepare their scope,
  but does not perform them.

## Assets, actors, and boundaries

Primary assets are mnemonic/private/PQC secret material, encrypted vaults and
password-verification material, approved transaction/message intent, exact
PSBT/sighash bytes, per-key PQC signature counters and cached signatures,
provider permissions, trusted network/chain selection, bundled WASM, and
release provenance.

Untrusted inputs include:

- arbitrary top-level pages, iframes, origins, page metadata, and provider RPC
  payloads;
- PSBTs, messages, approval-window lifetime changes, and caller-controlled
  retry sequences;
- indexer, fee API, RPC, network, and DNS responses;
- mnemonic backups and restore observations that may be stale or incomplete;
- npm registry packages, GitHub Actions, build hosts, caches, and the public
  `Qbit-Org` Core/electrs sources; and
- files accidentally introduced into the extension package.

Privileged components include the MV3 background service worker, content
script bridge, approval UI, wallet/keyring services, PQC/protocol modules,
extension storage, and release workflows. The browser/OS cryptographic
implementation, reviewed pinned commits, GitHub organization access, and
release operators are assumed trusted but fallible.

Important flows:

```text
untrusted page
  -> pageProvider (page world)
  -> per-document content-script port
  -> background provider session + permission
  -> approval UI snapshot
  -> wallet/keyring signer
  -> exact signed PSBT/message proof

indexer/network -> parsed, cross-checked wallet model -> approval -> signer

mnemonic restore -> address/history discovery -> persisted counter floors
                 -> signing gate opens only after durable scan

pinned source + lockfile + pinned toolchains -> deterministic bundle
  -> package policy -> per-entry manifest + ZIP SHA-256
```

## Vault and key handling

Threats:

- offline theft of extension storage followed by password guessing;
- plaintext mnemonic, password, private key, or PQC key leakage through logs,
  errors, browser storage, source maps, or package contents;
- unlocked state publication before recovery/counter checks complete;
- partially applied password or vault writes after a crash; and
- secret buffers surviving avoidably in WASM or JavaScript memory.

Controls and evidence:

- persisted keyrings are encrypted before the storage adapter receives them;
  a security test records every storage write and logger call and rejects the
  test mnemonic/password in either channel;
- every new encrypted field uses AES-256-GCM with a random 32-byte salt,
  random 16-byte IV, and PBKDF2-SHA-256 at 900,000 iterations; earlier
  10,000-round fields are authenticated and atomically re-encrypted before
  unlock is published;
- production package policy rejects source maps, TypeScript, tests, environment
  files, private-key-like files, and unmanifested entries;
- failed pre-unlock work clears decrypted state and does not publish the unlock
  event;
- keyring persistence rolls memory back when durable storage fails;
- PQC and derived classical secret byte arrays are zeroed in `finally` blocks;
  the PQC WASM tests also inspect scratch zeroization on failure; and
- the signing-source guard prevents transitive `elliptic`/Bitcore ECDSA from
  replacing the reviewed `tiny-secp256k1` wallet-signing route.

Residual risk:

- Existing weak-format vaults remain exposed to offline guessing until their
  first successful unlock completes the migration. The current passworder
  decrypts that earlier format. The earlier package remains installed but
  unused pending explicit approval to remove the dependency; a source guard
  forbids reintroducing its production import.
- JavaScript garbage collection prevents a general proof that every immutable
  string copy is erased. The design minimizes lifetime and forbids logging but
  relies on the browser process boundary.

## PQC counter custody and restoration

Threats:

- a crash after signing but before durable counter advancement;
- concurrent requests losing increments or consuming one counter twice;
- retries signing identical bytes repeatedly;
- restore lowering a known floor, opening before the scan completes, or losing
  a partially observed floor;
- stale backups, incomplete/malicious indexer history, or two live wallet
  instances undercounting actual signatures; and
- signing after the `2^30` policy limit.

Controls and evidence:

- signing is serialized by P2MR pubkey; the counter is reserved and the
  encrypted vault persisted before the signer callback runs;
- identical `(pubkey, signing digest)` operations reuse a durably cached
  signature without another increment;
- a pre-sign persistence failure prevents signing; post-sign failure never
  rolls a released signature's counter backward;
- concurrent distinct digests persist distinct monotonic increments and retain
  them after a new service instance unlocks;
- mnemonic restore persists `pqcFloorsPending`; signing remains closed across a
  crash until every discovered account receives a monotonic on-chain floor;
- partial floors and the concurrent-instance hint are persisted on scan
  failure; path/network changes re-arm the gate; and
- exhausted counters fail closed.

Residual risk:

- chain observation cannot see message signatures or transactions that were
  signed but never broadcast. A stale backup or maliciously incomplete indexer
  can therefore understate the restored usage floor. This is a bounded-signing
  budget and stale-backup risk, not evidence that the current SLH-DSA primitive
  reuses a stateful one-time key. Release UX must retain restored-floor and
  concurrent-instance warnings; a stronger multi-source/authenticated restore
  design requires protocol/product work.

## WASM and extension supply chain

Threats:

- replacing `pqc.wasm` or its JavaScript loader after review;
- loading remote/dynamic JavaScript or WebAssembly;
- shipping source maps, test fixtures, secrets, build paths, or an unexpected
  executable;
- non-deterministic timestamps, file modes, ordering, or host toolchains
  changing the reviewed ZIP; and
- a compromised package, Action tag, submodule, or build cache.

Controls and evidence:

- the Qbit SDK packages are exact npm versions whose registry integrity and
  provenance (signed `Qbit-Org` tags), and `@qbit-oss/pqc`'s WASM digests, are
  pinned in `scripts/security/sdk-package-pins.json`;
- the packaged PQC WASM must match the package's `SHA256SUMS` entry and the
  pinned digest;
  tamper tests alter both package and content bytes and require rejection;
- the MV3 worker imports a statically bundled WASM loader. No production source
  loads remote JavaScript; page injection uses only
  `chrome.runtime.getURL('pageProvider.js')`;
- production source maps are disabled and forbidden by the package validator;
- the ZIP writer sorts bytewise paths, fixes timestamps/modes, emits no
  directory records, and writes a per-entry SHA-256 manifest plus whole-ZIP
  digest;
- Node and pnpm are exact pins; registry packages require SHA-512 lock
  integrity; GitHub Actions use full commit IDs; and
- CI performs a frozen install, package validation, and two-clean-build
  byte comparison.

Residual risk:

- CSP includes `'wasm-unsafe-eval'` because WebAssembly compilation requires
  it. It does not enable JavaScript `eval`, and remote code remains disallowed.
- Toolchain pinning and reproducibility can show that two builders produced the
  same bytes; they do not prove those bytes are benign.
- The completed canonical drill repeated two clean package builds on one
  pinned builder. A separately authorized builder/operator must reproduce the
  reviewed commit before release to reduce common-host compromise risk.
- Core/electrs executable inputs come from the public `Qbit-Org/qbit` (signed
  release tag, checksum signature, and archive hashes) and
  `Qbit-Org/qbit-electrs` (exact commit). Release readiness allows only
  those two repositories and rejects variable-selected sources; the pins limit
  substitution but do not prove the pinned bytes are benign.

## Provider, origin, and approval surfaces

Threats:

- a page supplying a forged origin, icon, name, chain, account, approval result,
  or private control field;
- two documents in one tab sharing a session;
- iframe/all-frame confusion, service-worker restart, disconnect cleanup, or a
  revoked permission bypass;
- the request, account, chain, or PSBT changing while approval is open; and
- returning a finalized or materially modified PSBT after a sign-only
  approval.

Controls and evidence:

- the background takes the security origin from `port.sender.origin` (the
  browser's origin for the sending document), not page metadata, rejects a
  check-in whose origin is missing, opaque (`null`) or disagrees with the
  sender URL, and keys sessions by the exact runtime `Port` (#300);
- concurrent documents in one tab have distinct sessions; disconnect removes
  only that port's session;
- public/internal provider methods are separate; only `requestAccounts` can
  initiate a connection; privileged methods recheck permission, account, and
  chain after approval;
- caller-controlled approval/private fields and unsupported message modes are
  rejected;
- the approval payload is snapshotted and compared again before execution; and
- approved PSBT validation binds the unsigned transaction, witness UTXOs,
  P2MR leaf/control data, sighash type, outputs/memo bytes, and intended
  finalization state to the bytes passed to signing/broadcast.

Residual risk:

- the content script intentionally runs on all page origins so a website can
  discover/request the provider. This broad observation surface is mitigated
  by per-document origin binding and explicit permission/approval, but any new
  message route must receive the same checks.

## Phishing navigation protection

Threats:

- a page on a host in the bundled denylist running script before the wallet's
  warning appears;
- the wallet provider being exposed to a denylisted page;
- a Proceed bypass that the network layer ignores (a warning loop), or that
  outlives the browser session or lifts unrelated hosts; and
- a crafted warning-page URL sending Proceed to another site or a script URL.

Controls and evidence:

- in MV3, the background installs one dynamic `declarativeNetRequest` `block`
  rule whose `requestDomains` are the bundled denylist (each entry and its
  subdomains) for `main_frame` and `sub_frame` requests. A `block` rule needs
  only the `declarativeNetRequest` permission. A `redirect` rule would also
  need host access to every denylisted host, which the manifest does not
  request, so the redirect rules of earlier releases never fired. One update
  replaces every earlier dynamic rule;
- a blocked navigation never reaches the network and its page never commits;
  the browser shows its own blocked-by-extension error page. When the
  navigation starts from a page the content script runs in, such as a link
  click, the content script also asks the background to open the wallet's
  warning page with the blocked URL. A click that would follow a denylisted
  link in the same tab is cancelled before the browser starts that
  navigation, so the blocked page cannot replace the warning page; for a host
  the user proceeded to, the content script then follows the link itself.
  After any redirect to the warning page, the background waits for the tab to
  stop loading and redirects it once more if it shows neither one of the
  wallet's pages nor a page the content script runs on, which Chrome's
  blocked page never is, unless the user proceeded to the host in the
  meantime;
- the content script checks the page's hostname before anything else and
  injects the provider only after the background answers that the host is not
  denylisted; it retries a failed check once. A denylisted page, including one
  the user proceeded to and one whose hostname is not valid DNS syntax (such as
  `a_b.<entry>`), or a page whose check still fails, gets no provider, and a
  denylisted page the user has not proceeded to is sent to the warning page
  with its URL;
- Proceed is accepted only from the wallet's own top-level pages and only for
  a well-formed hostname covered by the bundled denylist. It adds a session
  DNR `allow` rule for top-level pages of that host and its subdomains, at a
  higher priority than the block rule, and the warning page navigates only
  after the rule is in place. Frames from the host stay blocked, so other
  sites cannot embed it. The in-memory navigation bypass covers the same
  hosts and is restored from the session rules when the service worker
  restarts, so the content script's verdict agrees with the network layer.
  Session rules end with the browser session or an extension update;
- the warning page returns only to an http(s) URL on the warned host, and
  otherwise to that host's HTTPS root;
- approval checks use the strict `checkWebsite()` verdict, which ignores
  navigation bypasses, so a host the user proceeded to still cannot obtain
  approvals. It blocks a denylisted host before any other origin check, so an
  HTTP origin or a label outside DNS syntax cannot soften the verdict to a
  warning; and
- `tests/e2e/scenarios/phishing.spec.ts` loads the MV3 build, maps two
  denylisted hosts to a loopback server, and asserts that a direct navigation
  fails with `net::ERR_BLOCKED_BY_CLIENT` without reaching the server, and that
  a link click shows the warning with the full URL, also when the service
  worker is already running at the click, after which Proceed loads that URL
  once, without returning to the warning or exposing the provider, while the
  other host stays blocked.

Residual risk:

- a navigation the content script cannot observe (a typed URL, a bookmark, or
  a link opened from another application) ends on the browser's generic
  blocked page, which neither explains the verdict nor offers Proceed. A
  denylisted link opened in a new tab or window shows that blocked page in
  the new one; unless it was middle-clicked, the tab it was clicked in is
  sent to the warning page;
- the background's follow-up cannot see the tab's URL. If the user leaves the
  tab for a page the content script does not run on, such as a browser page
  or a PDF, before the warning page has loaded, the tab can be sent to the
  warning page once more;
- MV2 builds have no DNR layer. There the content script's check, which runs
  after the page starts loading, is the only navigation control, and a
  denylisted page's own script can run before the warning appears; and
- the denylist is fixed per release and matches exact hostnames and their
  subdomains only (see `docs/privacy.md`).

## Malicious indexer and network behavior

Threats:

- malformed JSON, oversized numbers, duplicate rows, mismatched address/txid,
  or contradictory transaction/output records;
- an indexer inventing value/script/UTXO ownership, hiding spent status,
  replaying stale history, or lying about fees;
- DNS/TLS/provider compromise causing privacy loss, denial of service,
  overpayment, or unsafe coin selection; and
- a transient error being treated as definitive transaction absence.

Controls and evidence:

- response parsers reject malformed types, unsafe integers, duplicates, wrong
  address/txid, missing outputs, value/script disagreement, and non-P2MR
  funding claims;
- spendability derives from complete stability-checked history snapshots and
  cross-checks claimed outputs against the exact transaction;
- outpoints selected by in-flight approved sends are claimed before signing
  and rechecked at broadcast admission; overlap and concurrency tests fail
  closed;
- approval shows the exact fee, inputs, outputs, and memo bytes; signed PSBT
  validation preserves that intent; and
- definitive 404, transient failure, stale unconfirmed status, and fee-bump
  eligibility have separate tests.

Residual risk:

- an allowed indexer can omit UTXOs/history or return plausible but biased fee
  estimates. That can deny service or influence a user-approved fee. The wallet
  cannot prove global chain completeness from one unauthenticated indexer.
  Multi-provider/Core-backed verification is separate architecture work.
- the explorer refuses to list the outputs of an address over its
  `--utxos-limit` (the wallet assumes electrs' default of 500). The wallet then
  reads them from the address's history, which fails closed, or consolidates
  them in batches it verifies unspent. See
  [Explorer UTXO listing limit](./explorer-utxo-limit.md).
- network endpoints learn queried wallet addresses. This review does not claim
  network-level privacy.

## Dependencies and build infrastructure

Threats:

- mutable dependency/Action references, lockfile bypass, compromised registry
  content, unreviewed licenses, source-map leakage, and build-host tampering;
- a release workflow cloning or downloading from an arbitrary repository
  selected by an Actions variable; and
- CODEOWNERS existing without enforceable main-branch protection.

Controls and evidence:

- frozen lockfile install, exact package-manager pin, SHA-512 registry
  integrity, dependency-specifier policy, commit-pinned Actions, and a
  production license allowlist run in CI;
- crypto/custody packages and the current advisory snapshot are documented in
  `docs/security/dependency-review.md`;
- configured remotes of the root and of every initialized submodule,
  recursively, must be owned by `Qbit-Org`; a future `upstream` with another
  owner is a hard failure;
- CODEOWNERS covers vault/keyring, PQC/protocol, signing, provider approvals,
  manifests/build tooling, and release workflows; and
- release readiness reports missing branch protection without changing
  settings.

Residual risk:

- the installed production closure has a substantial advisory backlog,
  primarily in older build/development tooling classified as production
  dependencies. Contextual reachability is recorded, not erased.
- `main` is protected by ruleset 21680057 (one approval, CODEOWNERS review
  and two required checks), but organization admins and the repository admin
  role can always bypass it, and recent merges to `main` did (AR-03). Review,
  CODEOWNERS and required checks are therefore not enforced for
  administrators.
- workflow/Core/electrs sources are limited to the exact public `Qbit-Org`
  allowlist described in `docs/security/release-readiness.md`.

## MV3 and package audit

Reviewed Chrome MV3 boundary:

| Surface | Reviewed value |
| --- | --- |
| Permissions | `storage`, `unlimitedStorage`, `declarativeNetRequest`, `sidePanel` |
| Host permissions | two exact HTTPS qbit indexers and loopback regtest only |
| Content scripts | top-level all-origin provider bridge, `all_frames` absent |
| Web-accessible resources | packaged `pageProvider.js` only |
| External connection | absent |
| CSP | self scripts plus `wasm-unsafe-eval`; `object-src 'none'`; exact connect allowlist |
| Remote/dynamic code | no remote JavaScript; packaged page-provider injection and bundled WASM only |
| Production source maps | disabled and package-forbidden |
| Package policy | sorted safe paths, no duplicates, required bundles/WASM, no secrets/tests/sources/maps, per-entry and whole-ZIP hashes |

`declarativeNetRequest` is used for the local phishing `block` rule and the
session `allow` rules that Proceed adds (see "Phishing navigation protection");
`sidePanel` is used for the optional wallet panel; `storage` holds wallet state;
and `unlimitedStorage` supports local wallet/index state. Permission expansion
requires CODEOWNERS review and a package-policy expectation change.

## Required release gates

The internally actionable test/build gates are automated. Release remains
blocked until:

1. strict repository readiness passes (the executable-source and anonymous
   submodule-fetch gates are closed; the branch-protection admin-enforcement
   gate remains);
2. a repository administrator removes or narrows the `main` ruleset's
   administrator bypass (CODEOWNERS review is required since 2026-10-21);
3. a current dependency advisory snapshot receives named human disposition;
4. a separately authorized clean builder reproduces the recorded local
   two-build ZIP/manifest hashes and attaches them to the release record; and
5. the separately prepared external-review scope receives an explicit human
   decision. No reviewer was contacted by this work.
