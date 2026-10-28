# Release-readiness controls

`corepack pnpm release:readiness` is a read-only release check. It does not
change repository settings, publish artifacts, or contact reviewers.

The command:

- requires the root `origin` fetch and push URLs to resolve exactly to
  `Qbit-Org/qbit-wallet`;
- rejects every configured Git remote of the root and of every initialized
  submodule, recursively, whose owner is not `Qbit-Org`, including a future
  remote named `upstream` (each top-level submodule declared in `.gitmodules`
  must be initialized);
- redacts URL credentials before producing its JSON report;
- inventories executable Core/electrs source repositories declared by the
  conformance pin, release Dockerfiles, release workflows, and the regtest
  Compose file, and requires each to be exactly `Qbit-Org/qbit` or
  `Qbit-Org/qbit-electrs`, with no repository-variable or environment
  selector; and
- reads both the classic branch-protection endpoint and the repository rules
  (rulesets) that apply to `main`, merges them the way GitHub enforces them
  (the union of both), and reports missing settings, including settings that
  administrators can bypass, as a human gate; and
- requires every submodule URL in `.gitmodules`, including those declared by
  initialized submodules (CI initializes them recursively; the list of
  initialized submodules comes from `git submodule foreach --recursive`), to be
  fetchable without credentials. A missing URL, a URL that is not absolute `https`, an SSH or
  scp-style URL, and a URL with embedded credentials fail without a probe.
  Every other URL is probed with `git ls-remote <url> HEAD`, run outside the
  repository with only `PATH` inherited, `GIT_TERMINAL_PROMPT=0`, an empty
  credential helper and askpass, no global or system Git config, and only the
  `https` protocol allowed. Proxy variables are not inherited either, so a
  machine that reaches GitHub only through a proxy fails this check. Any
  failure, including a timeout, is a human gate, and the gate text includes
  each submodule's reason. `--offline` skips the probe and reports the
  unchecked URLs as a gate.

CI uses `--report-only`: remote ownership remains a hard failure, while missing
branch-protection settings, submodules that cannot be fetched anonymously, and
any non-allowlisted or variable-selected executable source remain visible human
gates, and the job passes. A release operator uses strict mode (the
default), which exits 2 until every gate is closed. Both modes also print each
open gate to stderr, as a warning in report-only mode and as an error in
strict mode (annotations in GitHub Actions).

## 2026-07-24 status

Superseded: see the 2026-10-23 status below.

- PR #148 is represented on `origin/main` by merge commit
  `c25ad3053f27750844350af00ef9ca03df7d1e37`.
- Root `origin` fetch/push and both initialized submodule remotes resolve under
  the wallet repository's owner; no root remote named `upstream` is configured.
- GitHub reports that `main` branch protection is missing. The checker only
  reports this; a repository administrator must decide and apply settings.
- The signed qbit Core runtime and electrs conformance source still reference
  `Qbit-Org` repositories. These are executable dependency sources, not the
  wallet pull-request upstream, but strict release readiness treats them as an
  open human gate.

## 2026-10-19 update: external-source gate closed

The 2026-07-24 plan to mirror Core and electrs into private repositories is
withdrawn. qbit-wallet is becoming public, so a private mirror would put a
dependency that outside developers cannot fetch back into the build. The source
of record is the public `Qbit-Org` repositories, pinned by exact commit or by
signed release plus hash:

- qbit Core: `Qbit-Org/qbit` tag `v1.0.0`, target
  `7ebcddb622d6e639041f005a189b048ec2a221fe`, tag and `SHA256SUMS` verified
  under signer `289EA3EC2F1939A24984840ED26CFC05586D371E`, both Linux archive
  SHA-256 values pinned in `scripts/conformance/core-pin.json`;
- electrs: `Qbit-Org/qbit-electrs` commit
  `5da0ce5f2da657dab6dd74b8108cb2b3e17da1e2`, built without credentials.

Readiness enforces an exact allowlist of those two repositories. Any other
repository, including another `Qbit-Org` repository or a private mirror, is
reported as external. The workflows and Compose file name the repositories
literally; candidate releases and electrs refs/images are explicit
`workflow_dispatch` inputs, not repository variables. The owner requirement
above still applies to the wallet's own Git remotes.
The Qbit SDK is no longer a submodule: it installs from npm
(`scripts/security/sdk-package-pins.json`).

Fixture provenance cites the same public sources: Core-derived fixtures name
`Qbit-Org/qbit` v1.0.0, and the SLH-DSA golden fixture names the public
`Qbit-Org` PQC library at the commit pinned in
`experiments/pqc-wasm/scripts/prepare-golden-upstream.sh`.

## 2026-10-23 status

With this check added on `release/1.0.5`, `pnpm release:readiness -- --report-only`
reports:

- remote ownership: pass;
- executable sources: pass (the two allowlisted `Qbit-Org` repositories only);
- `main` protection: present, from ruleset 21680057 with no classic branch
  protection. It finds required reviews, required status checks (it checks
  only that one named check is required; the ruleset requires `Typecheck,
  test, and build` and `Playwright G3 scenarios`) and required CODEOWNERS
  review. The one open gate is admin enforcement: organization admins and the
  repository admin role can always bypass the ruleset (AR-03).
- submodule fetchability: open gate. The qbit-pqc and qbit-js submodule
  repositories are private, and the anonymous probe fails for both with
  `could not read Username for 'https://github.com': terminal prompts
  disabled` (#288).

Strict mode therefore exits 2. Closing the remaining gates needs repository or
organization owners: narrowing the `main` bypass list, and making the qbit-js
and qbit-pqc submodule repositories public before or together with this
repository.

## 2026-10-26 status

The Qbit SDK now installs from npm (`@qbit-oss/pqc`, `@qbit-oss/protocol`,
`@qbit-oss/api` 0.1.0, published with provenance from the signed `v0.1.0`
tags of the public `Qbit-Org` repositories), so the repository has no
submodules and `.gitmodules` is gone (#288). `pnpm release:readiness` reports
remote ownership, executable sources and submodule fetchability (zero
submodules) as passing; the only open gate is `main` admin enforcement
(AR-03), so strict mode still exits 2.
