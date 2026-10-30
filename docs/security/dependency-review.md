# Dependency security and license review

Review date: 2026-10-29 (advisory refresh of the 2026-09-02 review; evidence
regenerated the same day after the build and test tooling paths to
`decode-uri-component` were removed)

Scope: the complete frozen pnpm workspace closure, including shipped extension
runtime packages, extension build and packaging dependencies, test-only tooling,
workspace contracts, security-adjacent packages, GitHub Actions, and license
metadata. Build dependencies are treated as release-supply-chain inputs rather
than being dismissed as non-production. This is an internal engineering review,
not an external audit, legal opinion, or organizational sign-off.

## Evidence binding

The evidence was generated from a clean tracked worktree at the audited code
commit below. The report and generated evidence files are committed afterward,
so the audited commit deliberately identifies the exact source, manifests,
policy, and lockfile that were executed.

| Evidence | Value |
| --- | --- |
| Audited commit | `9accff3baba6478eec73a95456f988ad8c370dd8` |
| Comparison commit (`origin/release/1.0.5`) | `c3d0f3a3674f76e4a3ff1a8efa1865638c5b2909` |
| Evidence-generation command | `corepack pnpm security:evidence` |
| Audit command | `corepack pnpm audit --json` |
| Frozen-install command | `corepack pnpm install --frozen-lockfile` |
| `pnpm-lock.yaml` SHA-256 | `87b9fb31de464eef495be721b1da2feee9ac332c78f5181de19002e24b8d0175` |
| [Raw audit output](./dependency-audit.json) SHA-256 | `40611505928f733b60d893599ec2d1c64fee775fc2689ce0ffef510beef63bff` |
| [Package inventory](./dependency-inventory.json) SHA-256 | `ba0836d1b9ad6e1dfc7015dd4be9de25ecb444d443740e5e8299e09e2f323f5d` |
| Qbit SDK npm packages | `@qbit-oss/pqc`, `@qbit-oss/protocol`, `@qbit-oss/api` 0.1.0, pinned in `scripts/security/sdk-package-pins.json` |

The inventory is the package-by-package machine-readable record. It contains
all 438 direct declarations, all 208 resolved packages classified as crypto-,
serialization-, networking-, or archive-adjacent, and every advisory with
directness, dependency paths, delivery context, and reachability.

## Outcome

The previous report's 112 vulnerable occurrences were not reused. A fresh
full-closure audit of the merged `origin/main` lockfile reported 216 vulnerable
occurrences: 9 critical, 103 high, 85 moderate, and 19 low. The original
dependency tranches reduced that result to 49 occurrences on 2026-08-05.
Although the lockfile was unchanged, advisory records published on August 6
and 7 raised the live result at PR head `aba54ae7` to 54 occurrences, including
five new highs. Targeted parent and direct-dependency upgrades reduced the
2026-08-18 result to 47 occurrences: 0 critical, 4 high, 33 moderate, and 10
low. Advisory records published after that refresh raised the live result at
the rebased PR head `40ac59c3` to 61 occurrences, including 15 highs across
`tar`, `pacote`, `browserslist`, and `fast-uri`. Root override upgrades on
2026-09-02 reduced that result to 50 occurrences: 0 critical, 4 high,
34 moderate, and 12 low. With the lockfile unchanged, advisory records
published through early October raised the live result on `main` at `5ec0f6a4`
to 106 occurrences, including 6 critical and 28 high, and the dependency-policy
job failed on every branch. The 2026-10-16 refresh reduced that result to 56
occurrences: 0 critical, 5 high, 41 moderate, and 10 low.
Removing the unused `typed-css-modules-loader` declaration, the only path to
the two accepted PostCSS advisories, then reduced that result to 45
occurrences: 0 critical, 1 high, 34 moderate, and 10 low. With the lockfile
unchanged, advisory records published from October 20 to 22 added 3 highs,
and GitHub withdrew the accepted `braces` high and a moderate `sprintf-js`
record on October 22 and 23. The live result at `e14fe9d4` on `release/1.0.4`
and `main`, measured on 2026-10-23 after both withdrawals, was 52
occurrences, and the dependency-policy job failed again. The 2026-10-23
refresh reduced the current result to 45 occurrences: 0 critical, 0 high, 35
moderate, and 10 low. On 2026-10-26 the Qbit SDK moved from submodules to the
npm packages `@qbit-oss/pqc`, `@qbit-oss/protocol` and `@qbit-oss/api`, which
add no advisory. Records published since October 23 for `fast-uri` and
`serialize-javascript` raised the result to 50 occurrences: 0 critical,
0 high, 37 moderate, and 13 low. With the lockfile unchanged, records
published or updated from October 27 to 29 raised the live result at
`ea8f3a5` on `release/1.0.6` to 53 occurrences, including the high
`decode-uri-component` record `GHSA-qr28-fpjm-wq7f`, and the
dependency-policy job failed again. Removing the build and test tooling
paths to `decode-uri-component` on 2026-10-29 reduced the current result to
50 occurrences: 0 critical, 0 high, 36 moderate, and 14 low.

| Snapshot | Critical | High | Moderate | Low | Total occurrences |
| --- | ---: | ---: | ---: | ---: | ---: |
| Merged baseline `dfc6c2e` | 9 | 103 | 85 | 19 | 216 |
| Prior audited result `8d87c4a` | 0 | 4 | 35 | 10 | 49 |
| Advisory-feed drift at unchanged-lock head `aba54ae` | 0 | 9 | 35 | 10 | 54 |
| Audited result `0f12d7b` (2026-08-18) | 0 | 4 | 33 | 10 | 47 |
| Advisory-feed drift at rebased head `40ac59c` | 0 | 15 | 34 | 12 | 61 |
| Audited result `c1098b3` (2026-09-02) | 0 | 4 | 34 | 12 | 50 |
| Advisory-feed drift at unchanged-lock `main` `5ec0f6a` | 6 | 28 | 60 | 12 | 106 |
| Audited result `60e5f4e` (2026-10-16) | 0 | 5 | 41 | 10 | 56 |
| Audited result `5ec04cd` (2026-10-16) | 0 | 1 | 34 | 10 | 45 |
| Advisory-feed drift at unchanged-lock `release/1.0.4` `e14fe9d` | 0 | 3 | 38 | 11 | 52 |
| Audited result `64309e9` (2026-10-23) | 0 | 0 | 35 | 10 | 45 |
| Audited result `c702dff` (2026-10-23, `patch-package` moved to development dependencies) | 0 | 0 | 35 | 10 | 45 |
| Audited result `eede40b` (2026-10-26, Qbit SDK from npm) | 0 | 0 | 37 | 13 | 50 |
| Advisory-feed drift at unchanged-lock `release/1.0.6` `ea8f3a5` | 0 | 1 | 38 | 14 | 53 |
| Current audited result `9accff3` (2026-10-29, `decode-uri-component` paths removed) | 0 | 0 | 36 | 14 | 50 |

pnpm's metadata counts vulnerable dependency occurrences, not independent
vulnerabilities. The final audit contains 42 advisory records representing 37
unique advisory/package pairs. Six records affect a directly declared package
and 36 are transitive. No critical or high advisory remains, and no risk
exception is in force.

Registry advisory data can change without a repository change, so this
snapshot is not permanent. The live audit runs in the `Dependency policy` CI
job on every pull request into `main` or a `release/*` branch and on every
push to `main`, and that job fails on any unaccepted critical or high
advisory. It is not a required status check: the `main` ruleset requires only
`Typecheck, test, and build` and `Playwright G3 scenarios`, so a failing
dependency-policy run does not block a merge ([Qbit-Org/qbit-wallet#5](https://github.com/Qbit-Org/qbit-wallet/issues/5)). It failed on
`main` at `e14fe9d4` (run 39671024040), and it passes on current pull
requests into `release/1.0.5` after #307 cleared the late-October advisories
(for example run 40008140587). It failed again on the 1.0.6 release pull
request at `ea8f3a5` (run 40939007581). The job also runs only on those events, so an
advisory published in a week without pushes is not reported until the next
run. The August feed drift introduced the Nx
remote-cache advisory `GHSA-vp3h-ghgh-jr7g`, two `image-size` advisories
(`GHSA-w3rx-r6r6-pgpr` and `GHSA-5p2g-fcmc-qvqq`), and predictable-output
advisories in both installed Nanoid version lines (`GHSA-28wg-ghj8-5hjv` and
`GHSA-2v37-7h3g-55p8`). All five were remediated without adding exceptions.
The September feed drift added the node-tar recursion advisory
`GHSA-r292-9mhp-454m`, the pacote denial-of-service advisory
`GHSA-w4pp-8pjf-rmxw`, two Browserslist advisories (`GHSA-c83g-rgw3-j3cx` and
`GHSA-73wf-gq98-2v4g`), and four `fast-uri` host-confusion and request-forgery
advisories (`GHSA-5jgf-p345-68v8`, `GHSA-f65p-4m7j-42xc`,
`GHSA-fph4-wmhf-6fwf`, and `GHSA-jqff-g426-hqxp`). All eight were remediated
through root override upgrades without adding exceptions.
The October feed drift added 28 critical/high records. Removing the unused
`webpack-dev-server` extension declaration cleared `webpack-dev-middleware`,
`node-forge`, `compression`, and `proxy-addr`; root override upgrades cleared
`axios`, `brace-expansion`, `fast-uri`, `handlebars`, `http-cache-semantics`,
`js-yaml`, `nx`, `probe-image-size`, `shell-quote`, `smol-toml`,
`source-map-js`, `svgo`, and `tinypool`. The `braces` record
`GHSA-vfj7-8cjw-p6xm` had no patched release and was the only one accepted as
an exception. The two PostCSS exceptions due on 2026-10-31 were removed with
their only dependency path instead of being renewed.
The late-October feed drift added two `follow-redirects` highs
(`GHSA-q3jh-wrc6-jgq8` and `GHSA-8r9p-f939-6h3c`) and five `vite` records for
its bundled `launch-editor` and dev server, including the high
`GHSA-587h-7wmj-h5pm`. Root overrides to `follow-redirects@1.16.1` and
`vite@6.4.4`, the first patched releases, cleared all seven. GitHub withdrew
the `braces` advisory `GHSA-vfj7-8cjw-p6xm` and the moderate `sprintf-js`
advisory `GHSA-hp3w-g68c-fv3c` on 2026-10-23 and 2026-10-22 respectively, so
the `braces` exception was deleted. Two new moderate records remain visible:
`@vitest/mocker` `GHSA-qxg6-89mg-rqv8`, patched only in Vitest 4.1.12 and
5.0.3, and `ip-address` `GHSA-rxp7-6hxx-x8q5`, patched in 10.7.4.
On 2026-10-29 the feed added the `decode-uri-component` high
`GHSA-qr28-fpjm-wq7f`: quadratic time in the fallback decoder, in 0.5.0 and
earlier. The only installed copy, 0.2.2, came in through `source-map-resolve`,
under gulp 4's `snapdragon` and under the `css` package that
`@testing-library/jest-dom` and `stylus` used. The patched 0.5.1 is an ES
module only, and `source-map-resolve` loads it with `require()`, so it was
not overridden. As on `release/1.0.7` (#90), the unused
`@testing-library/jest-dom` declaration was removed and gulp moved to 5.0.1
and `stylus` to 0.64.0, which removes every path to it. That cleared the
high, the moderate `GHSA-vcc3-ghjq-m6fr` for the same package and the
moderate `micromatch` 3 record `GHSA-952p-6rrq-rcjv`, and the packaged
extension is byte-identical. Two new records remain visible: the moderate
`vite` `GHSA-8g5g-mxqh-grgj`, patched in 6.4.5, and the low `deepmerge`
`GHSA-gcqx-w48m-w2h4`, which has no patched release.

## Package inventory

The 20 workspaces contain 2,388 registry lock entries and 438 direct dependency
declarations. Direct declarations are classified by how they enter the product
or engineering process:

| Delivery classification | Direct declarations | Meaning |
| --- | ---: | --- |
| Shipped runtime | 169 | Code or assets included in, or invoked by, the extension runtime |
| Extension build/packaging | 79 | Compilers, loaders, bundlers, service-worker tooling, and packaging inputs |
| Test-only tooling | 35 | Unit, browser, fixture, and conformance test dependencies |
| Development/quality tooling | 131 | Lint, formatting, repository tooling, and non-release developer commands |
| Workspace contract | 24 | Root/workspace linkage declarations that inherit use from consumers |

The `workspace contract` classification is kept separate because a root or
workspace-link declaration does not establish runtime reachability on its own.
The inventory records each declaration's manifest, dependency section,
specifier, resolved versions, delivery classification, and security-adjacent
categories.

Security categories intentionally overlap. For example, a network protocol
package may also serialize attacker-controlled data.

| Security-adjacent category | Resolved package/version records |
| --- | ---: |
| Crypto | 63 |
| Serialization | 96 |
| Networking | 44 |
| Archive/compression | 8 |

## Advisory directness and reachability

The final audit has the following direct advisory records:

| Direct package | Advisory | Severity | Reviewed path |
| --- | --- | --- | --- |
| `@sentry/browser` | `GHSA-593m-55hh-j8gv` | Moderate | Reachable shipped telemetry path |
| `moment` | `GHSA-4p3w-j4w9-5jqw` | Moderate | Reachable shipped dependency; modernization work |
| `vitest` | `GHSA-82fw-gwwq-j7x9` | Moderate | Test-only runner |
| `yaml` | `GHSA-48c2-rrv3-qjmp` | Moderate | Exact root policy/evidence parser plus transitive development, build, test, and conservatively reachable workspace-linked paths |
| `@babel/core` | `GHSA-4x5r-pxfx-6jf8` | Low | Build, test, and quality-tooling paths |
| `tsup` | `GHSA-3mv9-4h5g-vhg3` | Low | Development build tooling |

Across all advisory dependency paths, the inventory records 118 reachable
path occurrences, 1,613 extension-build occurrences, 1,862 test-only
occurrences, and 885 development-tooling occurrences. Moving `patch-package`
from `@qbit/keyring-service` dependencies to devDependencies (#289) took its
closure out of the production closure and removed 10 reachable path
occurrences; the advisory counts are unchanged. These are combinatorial
dependency paths and must not be added together as independent
vulnerabilities or execution flows. Every
path is retained so a future direct dependency or reachability change can
invalidate a stale disposition.

Path contexts retain both the vulnerable version and the direct package's
resolved version. Direct declarations and fallback closure metadata join on
that exact version, so parallel versions cannot inherit one another's delivery
or reachability classification.

Moderate and low findings remain visible and fail neither the current policy
nor this release baseline. They include reachable records in Sentry,
transitive packages such as `bn.js`, `react-router`, and `uuid`, the exact
direct and transitive `yaml` parser closure, and the reviewed low-severity
`elliptic` record. They remain modernization work;
their lower severity is not evidence of unreachability.

## Accepted high-risk dispositions

No high advisory record remains, and no schema-v2 exception is in force.

The two PostCSS records accepted on 2026-09-02 (`GHSA-6g55-p6wh-862q` and
`GHSA-r28c-9q8g-f849`, `postcss@6.0.1/7.0.39`) were reachable only through the
unused `typed-css-modules-loader` extension declaration. Tracked-source search
still found no webpack, Gulp, script, or source reference to it, and the
repository holds no generated CSS-module type declarations, so the 2026-10-16
refresh removed the declaration and deleted both exceptions before their
2026-10-31 expiry. All other critical and high build-path advisories found
since the merged baseline were upgraded; none was suppressed merely for being
build-only.

### braces

The `braces@3.0.3` exception for `GHSA-vfj7-8cjw-p6xm`, accepted on
2026-10-16 as conditionally reachable through Node-side build, test, lint, and
release tooling and tracked in #252, was deleted on
2026-10-23. GitHub withdrew the advisory that day, `pnpm audit` no longer
reports it, and the policy rejects an exception with no matching audit record.
The root `braces` 3.0.3 override predates the exception and is unchanged; it
keeps every path on the release that fixed `GHSA-grv7-fg5c-xmjg`.

## Crypto, serialization, networking, and archive review

The machine inventory is exhaustive. The following table calls out the custody
and protocol dependencies with the greatest impact:

| Package or source | Reviewed use | Disposition |
| --- | --- | --- |
| `@qbit-oss/pqc` 0.1.0 (npm) | PQC keys, signatures, counters, and WASM | Exact version, registry integrity, provenance (`Qbit-Org/qbit-pqc` `v0.1.0`) and WASM digests pinned; golden and qbit Core vectors, pin check, and extension import smoke are required here; package tests, MV3 smoke and reproducible rebuild run upstream |
| `@qbit-oss/protocol`, `@qbit-oss/api` 0.1.0 (npm) | qbit protocol/API encoding | Exact version, registry integrity and provenance (`Qbit-Org/qbit-js` `v0.1.0`) pinned; qbit Core sighash/PSBT vectors and protocol/Core conformance are required here; package tests run upstream |
| `@noble/curves` 1.4.2/1.7.0; `@noble/hashes` 1.4.0/1.6.0/1.8.0 | Curve and hash primitives | Retain exact closure and conformance evidence |
| `bitcoinjs-lib@6.1.6`; `tiny-secp256k1@2.2.3` | PSBT and classical signing | Wallet tests bind displayed and signed transaction bytes |
| `bitcore-lib@10.0.0`; `hdkey@2.1.0`; `bip39@3.1.0` | HD derivation, extended-key parsing, and mnemonics | Derivation/recovery tests required; no signing through transitive `elliptic` |
| `@metamask/browser-passworder@6.0.0` | Vault encryption and legacy migration | Exact direct pin; new writes carry 900,000-round PBKDF2 metadata and AES-256-GCM; migration tests fail closed on storage error |
| `browser-passworder@2.0.3` | Obsolete direct dependency | Source guard forbids import; retained pending explicit removal approval |
| `scrypt-js@3.0.1`; `crypto-browserify@3.12.1` | Crypto closure/browser compatibility | No new custody or signing use without review |
| `bs58check` 2.1.2/3.0.1; `varuint-bitcoin@1.1.2`; `bech32@2.0.0` | Bitcoin/address serialization | Covered by wallet and protocol tests |
| `@qbit-oss/protocol` | Local protocol serialization | Workspace source plus qbit Core conformance binds encoded behavior |

`elliptic@6.6.1` remains transitive with a low-severity ECDSA nonce advisory
and no patched release. Wallet signing uses `@qbit/wallet-core` ECPairs
backed by `tiny-secp256k1`; Bitcore and HDKey are restricted to derivation and
parsing. The security suite guards against introducing Elliptic/Bitcore ECDSA
signing. Such an import would invalidate this disposition.

| Adjacent area | Notable resolved dependencies | Boundary |
| --- | --- | --- |
| Networking | `@qbit-oss/api`, `@sentry/browser` 6.19.7/7.48.0, `ws` 7.5.13/8.21.1, `websocket-driver@0.7.5`, `node-fetch@2.7.0` | Runtime/API and telemetry inputs remain covered by type, unit, integration, and policy gates |
| Archive/compression | `browserify-zlib@0.2.0`, `gulp-zip@5.1.0`, `gzip-size@6.0.0`, `minizlib@3.1.0`, `modern-tar@0.7.7`, `tar-stream@2.2.0`, `tar@7.5.22`, `yazl@2.5.1` | Runtime decompression is separated from build/package tooling in the inventory |
| Serialization | `@qbit-oss/protocol`, `serialize-javascript@7.0.3`, `yaml`, Bitcoin encoders, and JSON-schema tooling | Runtime protocol paths are distinguished from test/build parsing paths |

## Dependency remediation tranches

The original remediation tranches were committed separately and followed by
the complete release-validation matrix. The 2026-08-11 advisory-feed response
was also separated by concern. Following the 2026-08-18 rebase, commit
`0f12d7b8` repaired the merged lock graph and reconciled the dependency evidence
with the language audit, then reran the dependency, build, typecheck, unit-test,
package, and deterministic-build gates that cover the changed closure. The
2026-09-02 pass addressed the Codex and Tenki review findings on the rebased
branch together with the September advisory drift, again separated by concern,
and reran the dependency, lint, build, and security-tooling gates listed below.
The 2026-10-16 advisory refresh (PR #251) separated the dependency changes,
the regenerated evidence, and the language-audit integration into their own
commits. The 2026-10-23 refresh committed the dependency change as
`64309e97`; the regenerated evidence and this review follow in a separate
commit. The same applies to the `patch-package` move in `c702dffc`.

| Commit | Reviewable tranche | Result |
| --- | --- | --- |
| `8b80c37` | Patch merged-lockfile criticals in Webpack, JSON Schema, shell quoting, and WebSocket tooling | Removed all critical findings |
| `bfac446` | Upgrade the Vitest/Vite test toolchain | Removed vulnerable test-chain highs while preserving tests |
| `867e654` | Upgrade vulnerable direct and transitive leaves, including Lodash/PostCSS families | Reduced runtime/build high exposure |
| `8137968` | Modernize legacy build parents, including SVGR, CSS minimization, Workbox, and related tooling | Removed the remaining active build-path critical/high findings |
| `c89f5be` | Make the full-closure dependency policy and CI jobs fail closed | Established the blocking policy baseline |
| `95bba39` | Pin the Prettier import-sort plugin's exact compiler peer | Made the build tool's clean-install peer resolution explicit and reproducible |
| `24616943` | Patch the newly disclosed `fast-uri` and `ip-address` highs | Restored zero unaccepted critical/high findings on the 2026-08-05 live audit |
| `db7c491e` | Bind license review directly to every exact lockfile identity | Removed pnpm store-index nondeterminism and expanded review from one version per package name to the full lock closure |
| `4baa1332` | Audit package references in every supported `npm exec` and `npm x` form | Closed mutable executable-package bypasses while preserving package-manager control arguments |
| `f72c329e` | Audit tracked manifests recursively through initialized submodules | Included all pinned submodule workspaces and failed closed on missing, drifted, or conflicted submodule checkouts |
| `cb8ea0b2` | Lint every tracked JS/TS source, test, build script, configuration, and initialized-submodule file | Replaced static path lists with deterministic tracked-file discovery and enabled React Hooks/security checks without hiding legacy debt |
| `092c9571` | Structurally parse lockfiles and workflow YAML, close runner/specifier/audit-metadata bypasses, and commit the evidence generator | Rejected duplicate/non-registry lock entries, YAML flow-form Actions, mutable runner aliases, and inconsistent high/critical audit metadata |
| `5eb79d71` | Guard the optional P2TR witness script exposed by the expanded lint/build validation | Preserved the non-P2TR fallback while restoring strict declaration-build typing |
| `91e59de1` | Permit replacement only of the two generated evidence targets | Kept source/config/lockfile cleanliness fail-closed while making exact-commit evidence regeneration repeatable |
| `2c838e15` | Reject explicit lockfile tarball overrides even when paired with registry-shaped keys and valid integrity | Prevented a frozen lockfile from redirecting an install to an attacker-controlled tarball |
| `75f18958` | Join dependency declarations, audit paths, and closure fallback by exact resolved version | Prevented parallel versions such as `yaml@1.10.2`/`2.8.1` and `uuid@8`/`9`/`11.1.0` from inheriting one another's reachability |
| `0ac70bca` | Enforce machine-checkable reachability guards for demonstrably unreachable exceptions | Made tracked build/script/config/source activation invalidate the PostCSS dispositions and prevented invalid exceptions from counting as accepted |
| `5bd0fc00` | Audit the `pnx` and `pnpx` fetch-and-run aliases | Prevented pnpm runner aliases from bypassing the exact-version requirement |
| `a971f40b` | Audit npm/pnpm initializer runners and validate complete registry identities | Covered `npm init/create/innit` and `pnpm create` while rejecting URL, Git, path, alias, tag, and range forms even when they end in a version-like suffix |
| `73985afb` | Cover Yarn, `yarnpkg`, and Bun runner variants | Applied the same exact-package policy to Yarn initializers, Corepack's alternate Yarn binary, `bun x`, and `bun create` |
| `3e25adbf` | Prefer direct-runner package references before the argument delimiter | Prevented a pinned post-delimiter child command from masking a mutable package selected by npm, npx, pnpm, Yarn, or Bun runners |
| `09bcc51a` | Reject package-manager registry and configuration overrides | Prevented a command from resolving an exact package identity through an attacker-controlled registry or configuration file |
| `f5cffd00` | Audit explicit `-p` and `--package` declarations across direct runners | Covered repeatable explicit package selections in pnpx, pnx, pnpm dlx, Yarn dlx, bunx, and `bun x` forms |
| `30f2ccc1` | Audit reordered direct-runner package flags | Added adversarial trailing-flag coverage; its initial interpretation was superseded by `a317f48b` after validating package-manager positional semantics |
| `a317f48b` | Preserve positional package selection once direct runners begin child arguments | Prevented an exact-looking trailing child flag from masking a mutable positional package across npx, pnpm, Yarn, and Bun runners |
| `91366780` | Audit npm-level package declarations before `exec` and `x` | Included every package selected by prefix and in-command `--package` options while retaining npm exec's documented option parsing |
| `21b6fe60` | Reject resolution-affecting runner environment configuration | Covered case-insensitive `npm_config_*` registry/config-file assignments, workflow environment keys, and npm's `--reg` shorthand |
| `e3ac1692` | Audit path-qualified package-manager binaries | Prevented absolute, relative, and repository-local runner paths from bypassing command policy without matching URLs or package/wrapper names |
| `61414eee` | Audit workflow runner environments independent of YAML key order | Prevented job or step environment configuration placed after a `run` key from changing the reviewed package registry |
| `a951932f` | Reject quoted or escaped package-manager executable names | Prevented shell token assembly such as `n\px` or `np""x` from bypassing the canonical runner parser |
| `8d87c4a6` | Reject scoped npm registry environment overrides | Prevented `npm_config_@scope:registry` assignments from redirecting an exact scoped package through an unreviewed registry |
| `2da74551` | Upgrade Lerna and pin Nx/devkit to 22.7.8 | Removed the vulnerable Nx remote-cache implementation from the full workspace closure |
| `3abd2f91` | Upgrade Less to 4.8.1 | Removed the unpatched legacy `image-size@0.5.5` closure through its direct build-tool parent |
| `b8088f88` | Upgrade direct Nanoid and PostCSS declarations | Patched both installed Nanoid advisory ranges and retained only the separately reviewed PostCSS exceptions |
| `670a1b7e` | Refresh the exact license baseline | Bound license review to all 2,566 identities in the remediated lockfile |
| `0f12d7b8` | Repair the rebased lock graph and language-audit integration | Restored frozen installs without changing package identities and kept generated dependency evidence inside exact reviewed residuals |
| `7868541c` | Drop the unused `@ts-expect-error` in the wallet-state expand-view hook | Restored the `@qbit/wallet-state` declaration build that gated the verify, Playwright, and conformance jobs |
| `1f977251` | Reject runner working-directory and prefix overrides and unreviewed npm pre-command options | Prevented `--prefix`, `-C`, `--dir`, or `--cwd` from resolving an exact package through a differently located `.npmrc` |
| `654108ae` | Require exact Corepack `<manager>@<spec>` downloads | Prevented `corepack pnpm@latest`, `corepack prepare`, and `corepack use` from fetching a mutable package manager |
| `50a23487` | Audit npm, pnpm, Yarn, and Bun install/add forms and aliases | Prevented `npm install -g mutable-tool@latest` style fetches of unaudited mutable packages |
| `6ceb8bd8` | Normalize a delimiter placed before the command word | Prevented `npm -- exec mutable-tool@latest` from truncating the audited command |
| `36558d21` | Reject shell expansion in an executable's name | Prevented `X=; np${X}x mutable-tool@latest` and command substitution from synthesizing a package manager the textual audit never sees |
| `3287de20` | Write both generated evidence files only after both are computed | Prevented a mid-generation failure from leaving a refreshed audit snapshot beside a stale inventory |
| `bb1fe823` | Compose the shared lint rules for both lint entry points | Removed rule drift between the workspace and repository ESLint configurations without changing either configuration's effective output |
| `50075ed5` | Audit tracked `.npmrc` keys and reject other package-manager configuration files | Prevented a tracked registry or config-file key from redirecting installs or hiding advisories before the policy job runs |
| `9676078f` | Guard the inactive `AddressInput` effect | Stopped an inactive recipient input from reporting an address to its parent |
| `4e828a27` | Onboard new lockfile identities as `pending-review` records | Made license-baseline regeneration possible while keeping the policy fail-closed until a reviewer approves each new identity |
| `1fca3e27` | Patch the `tar`, `pacote`, `browserslist`, and `fast-uri` highs through root overrides | Restored zero unaccepted critical/high findings on the 2026-09-02 live audit without adding exceptions |
| `c1098b39` | Refresh the exact license baseline | Bound license review to all 2,547 identities in the remediated lockfile, including the reviewed `lucide-react` replacement for Font Awesome |
| `60e5f4e8` | Remove the unused `webpack-dev-server`, pin patched releases for the October advisories, review 28 new license identities, and accept `braces` | Restored zero unaccepted critical/high findings on the 2026-10-16 live audit with one new exception for an advisory that has no patched release |
| `dafc8d03` | Regenerate the dependency evidence | Bound the audit snapshot and inventory to the remediated lockfile |
| `26447f36` | Treat the risk-exception file as reviewed dependency metadata in the language audit | Allowed exact audit paths that contain external package names such as `fork-ts-checker-webpack-plugin` |
| `5ec04cde` | Remove the unused `typed-css-modules-loader` and delete both PostCSS exceptions | Removed `postcss@6.0.1/7.0.39` from the lockfile, leaving `braces` as the only accepted high record |
| `28dc2e5e` | Regenerate the dependency evidence | Bound the audit snapshot and inventory to the lockfile without the loader |
| `64309e97` | Pin patched `follow-redirects` and `vite` releases, review two new license identities, and delete the withdrawn `braces` exception | Restored zero critical/high findings on the 2026-10-23 live audit with no exception in force |
| `c702dffc` | Move `patch-package` to `@qbit/keyring-service` devDependencies and mark the wallet packages private (#289) | Classified `patch-package` as development tooling; the live audit stayed at zero critical/high findings |

## Lint and dependency policy jobs

CI now exposes stable top-level jobs named `Lint` and `Dependency policy`.
Both perform a frozen install using the repository's exact pnpm and Node pins.
The lint entry point is the deterministic root command `corepack pnpm lint`;
it runs every workspace lint script and then all 830 tracked `.cjs`, `.js`,
`.mjs`, `.ts`, and `.tsx` files, including tests, extension build/packaging
scripts, root/workspace configs, and initialized submodules. ESLint-recommended
correctness checks, dynamic-code/URL security rules, and React
`rules-of-hooks` are blocking errors. Named legacy TypeScript/style and
`exhaustive-deps` debt remains visible as warnings rather than being globally
disabled; the 2026-09-02 run had zero errors with 894 warnings still visible.
Both lint entry points compose their shared dynamic-code, React Hooks,
unused-variable, and `chrome` global rules from `.eslintrc.shared.cjs`.

`corepack pnpm security:dependencies` and its adversarial tests fail closed on:

- any unaccepted critical/high advisory in the live full closure;
- an exception with a missing exact package/advisory/version/path match,
  reachability analysis, machine-checked absence guard, controls, owner,
  expiry, removal plan, or Qbit-Org/qbit-wallet tracking issue;
- an expired exception or one issued for more than 180 days;
- Git, URL, filesystem, mutable-tag, or otherwise unpinned dependency
  declarations, including root pnpm overrides;
- ambiguous/duplicate lockfile keys, non-registry resolutions, explicit
  tarball overrides, or any registry lock entry without SHA-512 integrity;
- a structurally parsed third-party GitHub Action, including YAML flow forms
  and quoted keys, not pinned to a lowercase 40-character commit;
- mutable package/workflow execution through npm, pnpm, Yarn, or Bun direct
  runners, initializer aliases, and install/add forms (including path-qualified
  binaries, rejected quoted/escaped spellings, shell expansion in an
  executable's name, a delimiter placed before the command word, and mutable
  `<manager>@<spec>` Corepack downloads), package-manager registry,
  configuration, working-directory, or prefix flags, global or scoped registry
  environment assignments, order-independent workflow environment
  assignments, or a browser release alias such as `stable`;
- an unreviewed key in a tracked `.npmrc`, or any tracked Yarn, Bun, or
  pnpmfile configuration file;
- a license record still marked `pending-review`;
- inconsistent critical/high audit occurrence metadata or missing advisory
  finding records; and
- any unexplained package addition, removal, version/license-expression change,
  or unknown-license-file hash change against the exact full-closure baseline.

The audited policy checked 2,388 integrity-pinned registry entries, 487
dependency specifiers, 33 Action references, one tracked package-manager
configuration file, 273 executable package/workflow commands, and 2,273 exact
package/version license records. The browser
smoke-test installer is an exact direct dependency and installs
`chrome@148.0.7778.97`; it no longer downloads mutable `stable` through
`pnpm dlx`. Tracked-file discovery recurses into any initialized submodule
and fails before review if a checkout is absent, conflicted, or differs from
its recorded gitlink; since 2026-10-26 the repository has none, and the Qbit
SDK comes from npm (`scripts/security/sdk-package-pins.json`). `corepack pnpm security:evidence` is now a tracked,
exact-dependency command that refuses dirty source/config/lockfile inputs and
binds both generated outputs to the audited commit and audit bytes.

## License baseline

`scripts/security/dependency-license-baseline.json` records the package,
version, and normalized license expression for all 2,273 distinct identities
in the complete lockfile closure, including parallel versions and
platform-specific optional packages. The baseline is bound to the exact
`pnpm-lock.yaml` SHA-256, while every one of the 2,388 peer variants must retain
SHA-512 registry integrity. Package additions, removals, version changes, and
any lockfile change therefore fail CI until the license review is deliberately
updated.

The CI gate derives its identity set directly from the committed lockfile. It
does not invoke `pnpm licenses list`: pnpm 8.6.0's command failed on clean Linux
installs when a package store-index file was absent, first for
`@vue/compiler-sfc` and later for `@testing-library/dom`, even though the frozen
install itself succeeded. It also emitted only one version per package name.
Direct lockfile validation removes both the store-layout dependency and that
version-collapsing blind spot. Newly added non-platform records were reviewed
from exact installed manifests; 90 non-host platform binary records inherit the
MIT license verified on the matching esbuild, Nx, Parcel watcher, or Rollup
package family, and two non-hoisted versions retain their same-package reviewed
license. The baseline preserves 16 version-specific license-expression
differences that the former one-version-per-name output could not represent.
The 2026-09-02 refresh onboarded `lucide-react@1.34.0`, `tar@7.5.22`,
`pacote@21.5.1`, and `fast-uri@3.1.6` through the pending-review flow, reviewed
each against its installed manifest and license file, and removed the five
Font Awesome records plus the 18 identities superseded by the advisory patches.
The 2026-10-16 refresh onboarded 28 identities through the same flow, each
checked against the registry license for its exact version and against the
license recorded for its previous version, and dropped the identities removed
with `webpack-dev-server` and the superseded versions. Removing
`typed-css-modules-loader` then dropped 29 more identities, including
`postcss@6.0.1` and `postcss@7.0.39`. The 2026-10-23 refresh onboarded
`follow-redirects@1.16.1` and `vite@6.4.4` through the pending-review flow,
verified MIT against each installed manifest and license file, confirmed that
the bundled-dependency license notice in `vite@6.4.4` is byte-identical to
6.4.3's, and dropped the superseded `follow-redirects@1.16.0` and `vite@6.4.3`.

Lockfile changes are onboarded with
`corepack pnpm security:dependencies -- --write-license-baseline`. The command
rebinds the baseline to the current `pnpm-lock.yaml`, drops identities the
lockfile no longer contains, and records every new identity as
`pending-review: <license observed in the installed manifest>` (or
`license metadata unavailable`). Nothing is approved automatically, even when
the observed expression is on the allowlist: the policy fails closed on every
pending record until a reviewer verifies the package's license and replaces the
marker with the reviewed expression.

Four packages need file-level evidence because metadata collection reports an
unknown or ambiguous license:

| Package | Reviewed disposition | License-file SHA-256 |
| --- | --- | --- |
| `bigi@1.4.2` | Permissive text in `LICENSE.md` | `2ec211b33474976515790a5d980db86edbb5fdb6f754e9b52fc51a3207aaf1f2` |
| `buffer-compare@1.1.1` | MIT text in `LICENSE` | `7e13db436c0a802ef58d0096cc07323e53ad64ab9a5f3260c53e003e6dcd77d6` |
| `react-cache@2.0.0-alpha.1` | MIT text in `LICENSE` | `52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85` |
| `spawndamnit@3.0.1` | MIT text in `LICENSE` | `aac99045d4e36ab3b1e2914337620963b56cbac53de280c94f29261a22ab5b0f` |

The earlier MPL-2.0 provenance introduced through
`@metamask/browser-passworder` remains recorded in the exact baseline. License
allowlisting is an engineering control, not legal approval; release publication
still requires the applicable notices and source-obligation review.

## Validation evidence

The gates covering the changed dependency and build paths passed at the audited
dependency commit. Environment-dependent release integration not run locally is
identified below and remains subject to the PR's branch CI:

| Gate | 2026-09-02 refresh result | 2026-10-16 refresh result | 2026-10-23 refresh result |
| --- | --- | --- | --- |
| Frozen install | Passed with the lockfile unchanged | Passed with the lockfile unchanged | Passed against the regenerated lockfile |
| Root lint | Passed with zero errors; 894 legacy warnings remain visible | Passed with zero errors; 893 warnings remain visible | Passed with zero errors; 893 warnings remain visible |
| Workspace declaration/background builds | Passed | Passed | Passed |
| Typecheck | Passed | Passed | Passed |
| Workspace unit tests and PQC golden vectors | Passed | Passed, including the full suite under the `tinypool` 2.1.2 override | Passed: 22 Vitest suites, 2,110 tests, on `vite@6.4.4` |
| Security policy unit/adversarial suite | 60 policy-tooling tests and the 13-scenario adversarial suite passed | 95 policy-tooling tests and the adversarial suite passed | 99 policy-tooling tests and the 13-scenario adversarial suite passed |
| Live dependency policy | Passed; 0 unaccepted critical/high findings | Passed; 1 accepted (`braces`) and 0 unaccepted critical/high records after the PostCSS exceptions were removed | Passed; 0 critical/high records and no exception in force |
| Extension build/package | Not rerun locally; remains a branch CI gate | Passed locally and in branch CI | Passed locally; neither updated package appears in `apps/extension/dist/chrome` |
| Deterministic extension packaging | Not rerun locally; remains a branch CI gate | Passed locally as a non-canonical drill (`--allow-toolchain-mismatch`); canonical run in branch CI | Passed locally on the pinned Node 22.22.3 and pnpm 8.6.0 |
| PQC suite | Golden fixture verified locally; build, WASM hash, MV3 smoke, import smoke, and reproducible rebuild remain branch CI gates | Golden fixture verified locally; `Verify @qbit/pqc` passed in branch CI | Golden fixture verified locally; remaining PQC gates run in branch CI |
| Playwright | Not rerun locally; remains a branch CI gate | `Playwright G3 scenarios` passed in branch CI | Not rerun locally; remains a branch CI gate |
| Regtest integration smoke | Not rerun locally; remains a branch CI gate | Not rerun locally; runs in the `conformance-smoke` job, which passed in branch CI | Not rerun locally; remains a branch CI gate |
| qbit Core conformance | Not rerun locally; remains a branch CI gate | `conformance-smoke` passed in branch CI | Not rerun locally; remains a branch CI gate |

The local evidence host ran the repository pins, Node 22.22.3 with pnpm 8.6.0
through Corepack; gates not rerun locally remain enforced by the PR's branch
CI. The 2026-10-16 refresh ran locally on Node 22.23.3 with pnpm 8.6.0, so the
deterministic-packaging drill there is non-canonical; branch CI runs the
pinned toolchain. The 2026-10-23 refresh ran locally on the pinned Node
22.22.3 and pnpm 8.6.0.

## Limitations and ongoing ownership

- The policy and inventory establish repository and release-path controls; they
  do not prove that an upstream publisher or pinned Action commit is benign.
- Advisory severity and path analysis are inputs, not substitutes for exploit
  review. Moderate and low findings remain tracked in the generated inventory.
- No risk exception is in force, so any new critical or high record fails CI
  until it is patched or accepted through a schema-v2 exception.
- Release evidence must retain the policy output, audit snapshot, inventory,
  submodule commits, extension ZIP manifest, and extension ZIP SHA-256.

Dependency modernization and exception removal are tracked in issue #161.
The work also supports the broader release-readiness context in #96, #79,
and #77.
