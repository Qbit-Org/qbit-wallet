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
- a lock and unlock replacing the live keyrings while a signature or keyring
  change waits, so its change lands on a keyring the vault never saves;
- retries signing identical bytes repeatedly;
- restore lowering a known floor, opening before the scan completes, or losing
  a partially observed floor;
- stale backups, incomplete/malicious indexer history, or two live wallet
  instances undercounting actual signatures; and
- signing after the `2^30` policy limit.

Controls and evidence:

- signing is serialized by P2MR pubkey; the counter is reserved and the
  encrypted vault persisted before the signer callback runs;
- each counter operation re-checks under its counter lock that its keyring is
  still live, and each vault write fails, without committing, when a keyring
  it changed is no longer live, so a lock and unlock fails the signature or
  keyring change instead of releasing or reporting it;
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
  only the `declarativeNetRequest` permission. One update replaces every
  earlier dynamic rule, including the redirect rules of 1.0.4 and earlier,
  which never fired for lack of host access. A denylist entry that a DNR rule cannot
  name (not ASCII, or not a canonical public hostname) is left out and logged,
  so it cannot fail the whole rule. When the update fails, the background
  removes the redirect rules of earlier releases on their own, keeps a block
  rule an earlier install left, and retries after 1, 4 and 15 seconds, then
  every minute while the service worker runs, up to ten attempts; a worker
  that stops starts over at its next start.
  `GET_PHISHING_STATS`, which only the wallet's own pages may send, reports
  the rule's health as `networkRules` (`installing`, `installed`, `retrying`,
  `failed`, `unknown` or `unsupported`, with the reason and the number of
  domains the browser holds), read back from the browser rather than assumed.
  A rule found missing at such a read reads as `retrying` and is installed
  again, and `FORCE_UPDATE_PHISHING_LIST` installs it again too. With DNR it
  also reports `protection`, the state of the network layer as a whole:
  `degraded` while the block rule is not installed or a redirect rule without
  host access may still be in place, `unknown` while either cannot be read
  or the redirect rule's state does not arrive within two seconds, and
  `full` otherwise, with the reasons and the redirect rule's own state
  (`installed`, `not-wanted`, `missing`, `removing`, `removal-failed` or
  `unknown`), its host access, last error and next retry; the block rule's
  health comes back whatever happens to that read. Concurrent requests
  share one read. A read that finds a redirect rule in place without host
  access, with no attempt scheduled or queued, starts its removal once its
  answer reaches a request still waiting for it; it neither clears a
  recorded failure nor supersedes a queued retry. No wallet screen shows
  this health yet;
- above the block rule, a session `redirect` rule sends a top-level
  navigation to a denylisted host to the wallet's warning page before it
  reaches the network, however the tab got there: a link, a typed URL, a
  bookmark, another application, or a redirect chain such as a same-site
  302, `t.co` or a mail safe-link. A `redirect` fires only with host access to
  the request URL (not its initiator), so the manifest requests
  `*://*.<entry>/*` for each denylisted domain, generated at build from the
  bundled denylist and pinned by the package policy. The content script's
  `<all_urls>` match already brings the all-sites install warning, so these
  add none (`chrome.management.getPermissionWarningsByManifest` reports the
  same single warning with and without them). The rule's target is
  `phishing-warning.html`, the only web-accessible page, which a website
  cannot open or frame: it is reachable only under a per-session dynamic URL
  (`use_dynamic_url`). That page reads the blocked URL from its fragment,
  accepts only an http(s) URL with a host, and replaces itself with the
  warning screen for it: with the full URL up to 8192 characters, and with
  only its origin beyond that (where Proceed then goes). Anything
  else gets the warning without a site and without Proceed. It never
  navigates to the URL itself. Without
  host access a `redirect` rule does not fire but still outranks the block
  rule, so the page would load. The background therefore keeps the rule only
  while `chrome.permissions.contains` reports access to every denylisted
  domain, removes it when the user withholds site access
  (`permissions.onRemoved`), adds it back when access returns
  (`permissions.onAdded`), checks again at each service-worker start and on
  `FORCE_UPDATE_PHISHING_LIST`, retries a failed update after 1, 4 and 15
  seconds, then every minute while the service worker runs, up to ten
  attempts per change, or for as long as a removal fails, and treats a failed
  access check as no access until a retry gets an answer;
- while the redirect rule is not in place, a blocked navigation never
  reaches the network and its page never commits; the browser shows its own
  blocked-by-extension error page. When the navigation starts from a page
  the content script runs in, such as a link click, the content script also
  asks the background to open the wallet's warning page with the blocked
  URL. A click that would follow a denylisted
  link in the same tab is cancelled before the browser starts that
  navigation, so the blocked page cannot replace the warning page; for a host
  the user proceeded to, the content script then follows the link itself.
  While the redirect rule is in place, a link that opens a new tab or window
  (target `_blank`, or a Ctrl-, Cmd- or Shift-click) gets the warning in the
  new tab from that rule, and the background leaves the source tab and its
  page alone. It sends the source tab to the warning page as above unless it
  confirms within a second, from the browser's rules and host access, that
  the redirect rule is in place for that canonical host with no update to it
  queued or running.
  After any redirect to the warning page, the background waits for the tab to
  stop loading and redirects it once more if it shows neither one of the
  wallet's pages nor a page the content script runs on, which Chrome's
  blocked page never is, unless the user proceeded to the host in the
  meantime;
- on a top-frame page whose host the bundled denylist covers, the content
  script stops the page (`window.stop()`) at `document_start`, before any of
  the page's own script runs, and waits for the background. That covers a
  network layer that is missing, for example because its rule failed to
  install, on the sites the wallet may access: the browser runs no content
  script where the user withholds site access. A page the background sends
  to the warning page stays stopped,
  and one whose check does not answer within 3 seconds, or whose warning page
  does not arrive, shows a notice with a retry instead of a blank page. A
  page the background lets through, because the user proceeded to it, is
  recorded in the page's own sessionStorage and reloaded once; later loads of
  that origin in the tab run, and are still checked. A page whose check finds
  it denylisted again loses that record. A page whose sessionStorage the
  content script cannot use, such as one its server sandboxes or one whose
  site data the user blocks, stays held even after Proceed and says why, so
  the server cannot turn the hold off. A page held again on a reload is not
  reloaded once more without the user asking, so a lost record cannot cause
  a reload loop;
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
  higher priority than the block and redirect rules, and the warning page
  navigates only after the rule is in place. Frames from the host stay blocked, so other
  sites cannot embed it. The in-memory navigation bypass covers the same
  hosts and is restored from the session rules when the service worker
  restarts, so the content script's verdict agrees with the network layer.
  Session rules end with the browser session or an extension update;
- the warning screen offers Proceed only for a hostname that passes the same
  DNR hostname check (`parseDnrDomain`) as the background's; for any other,
  such as a denylisted name outside DNS syntax, it offers none and says that
  the site cannot be opened from there, as it does when the background
  refuses a Proceed it offered;
- the warning page returns only to an http(s) URL on the warned host, and
  otherwise to that host's HTTPS root;
- approval checks use the strict `checkWebsite()` verdict, which ignores
  navigation bypasses, so a host the user proceeded to still cannot obtain
  approvals. It blocks a denylisted host before any other origin check, so an
  HTTP origin or a label outside DNS syntax cannot soften the verdict to a
  warning; and
- `tests/e2e/scenarios/phishing.spec.ts` loads the MV3 build, maps two
  denylisted hosts and a link-wrapper host to a loopback server, and asserts
  that a direct navigation, a same-site 302 and a link wrapper's cross-site
  302 to a denylisted host each show the warning with the full URL without
  reaching the server, after which Proceed loads the site; that with site
  access withheld in the browser's extension settings a direct navigation
  fails with `net::ERR_BLOCKED_BY_CLIENT` without reaching the server, and
  shows the warning again once access is granted, while the reported
  protection stays `full` with the redirect rule `not-wanted` and then
  `installed`; that a link opening a new tab shows the warning in that tab
  while the source tab keeps its page; that the reported protection is
  `full` with both rules in place; that the warning screen for a denylisted
  name outside DNS syntax offers no Proceed and says why; and that a link
  click shows the warning with the full URL, also when the service worker is
  already running at the click, after which Proceed loads that URL once, without
  returning to the warning or exposing the provider, while the other host
  still gets the warning. With the block rule removed, a direct navigation
  shows the warning without running the page's inline script, the reported
  health is `retrying` until the rule is installed again, and Proceed then
  loads the page after one reload.

Residual risk:

- while the user withholds the wallet's site access (Chrome's "On click" or
  "On specific sites"), the redirect rule is removed and a top-level
  navigation to a denylisted host, whether typed, bookmarked, opened from
  another application or reached through a redirect or link wrapper, ends on
  the browser's generic blocked page, which neither explains the verdict nor
  offers Proceed. The content script does not run on withheld sites either.
  Between the moment access is withheld and the background removing the
  rule, and for as long as that removal keeps failing, a navigation to a
  denylisted host is redirected nowhere and loads; `GET_PHISHING_STATS`
  reports that window as `protection` `degraded`, with the redirect rule
  `removing` or `removal-failed`. A
  denylisted page in a frame always gets the browser's blocked page;
- while the block rule is not installed (`installing`, `retrying` or
  `failed`) and the user withholds the wallet's site access on a denylisted
  site ("On click", or "On specific sites" without that site), nothing stops
  a page there: the redirect rule is removed, and the content script's hold
  does not run, so the page loads and runs its own script. The
  `GET_PHISHING_STATS` health reports this as `protection` `degraded` with
  `block-rule-not-installed` and `site-access-withheld`, or
  `site-access-unknown` when the browser cannot say; no wallet screen
  shows it yet;
- an enterprise policy that blocks the wallet on a denylisted host
  (`runtime_blocked_hosts`) was not tested. If Chrome still reports host
  access there through `permissions.contains`, the redirect rule stays in
  place without firing on that host, and its pages load. The user's own "not
  allowed on this site" list was tested and keeps the warning;
- after the browser starts, the session redirect rule is back once the
  service worker has started (the worker listens for the browser's start);
  a tab restored before then gets the browser's blocked page;
- the warning page's address carries the blocked URL, so it stays in the
  tab's history, as it did when the content script opened the warning. A
  browser that does not enforce `use_dynamic_url` lets a website open
  `phishing-warning.html` by its fixed URL; it then shows only the warning
  screen for the URL in its fragment, and Proceed is still accepted only for
  a denylisted host;
- the background's follow-up cannot see the tab's URL. If the user leaves the
  tab for a page the content script does not run on, such as a browser page
  or a PDF, before the warning page has loaded, the tab can be sent to the
  warning page once more;
- MV2 builds have no DNR layer. There the content script's hold is the only
  navigation control. It covers top-level pages only, so a denylisted page in
  a frame can run its own script;
- the record of a release lives in the page's own sessionStorage, so a page
  that has run script in a tab, because the user proceeded to it there or
  before its host was denylisted, can write it, also again after its check
  removed it, and skip the hold on its later loads in that tab; its check
  still sends it to the warning page. A page that has not run script in the
  tab cannot write it before it is held. A record that a restored tab brings
  back from an earlier browser session, whose Proceed has ended, likewise
  skips the hold until the check removes it. A page the user proceeded to
  whose sessionStorage cannot be used, for example because the user blocks
  cookies and site data, never loads;
- while the MV3 block rule is missing, a denylisted page in a frame runs its
  own script: the content script runs in the top frame only and holds only
  top-level pages;
- after Proceed, the first load of each origin of the host in a tab is
  stopped and reloaded once. The server gets that request twice, so a
  one-time link is spent by the first load, and a form posted to it from
  another tab is sent again once the browser has asked to resubmit it;
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
| Host permissions | two exact HTTPS qbit indexers; `*://*.<entry>/*` for each bundled phishing denylist domain, generated at build and pinned by the package policy, for the warning redirect; optional loopback regtest |
| Content scripts | top-level all-origin provider bridge, `all_frames` absent |
| Web-accessible resources | packaged `pageProvider.js`; `phishing-warning.html` under a per-session dynamic URL only |
| External connection | absent |
| CSP | self scripts plus `wasm-unsafe-eval`; `object-src 'none'`; exact connect allowlist |
| Remote/dynamic code | no remote JavaScript; packaged page-provider injection and bundled WASM only |
| Production source maps | disabled and package-forbidden |
| Package policy | sorted safe paths, no duplicates, required bundles/WASM, no secrets/tests/sources/maps, per-entry and whole-ZIP hashes |

`declarativeNetRequest` is used for the local phishing `block` rule, the
session `redirect` rule to the warning page, and the session `allow` rules
that Proceed adds; the denylist host permissions let only that redirect fire
(see "Phishing navigation protection");
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
