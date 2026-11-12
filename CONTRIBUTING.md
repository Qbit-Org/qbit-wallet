# Contributing to Qbit Wallet

Thank you for helping improve Qbit Wallet. This guide explains how to set up
the project, make a change, and get it merged.

Found a security problem? Do not open an issue. Follow
[SECURITY.md](SECURITY.md) instead.

## Before you start

- **Bugs:** open an issue with steps to reproduce, the extension version, and
  your browser version.
- **Small fixes** such as typos, docs, or tests: open a pull request directly.
- **Larger changes:** open an issue first so we can agree on the approach.
  This matters most for anything touching keys, signing, approvals,
  permissions, or the build pipeline.

## Set up

Requirements:

- Node.js, at the version in [`.nvmrc`](.nvmrc)
- pnpm 11.28.9, the `packageManager` pin in `package.json`, run through
  Corepack. After `corepack enable`, `pnpm` is Corepack's shim, which checks
  the pnpm it downloads against the pin's sha512 hash. A pnpm installed
  another way, such as `npm install -g pnpm` or `pnpm/action-setup`, is not
  checked.
- Docker, if you want to run the regtest harness or end-to-end tests

Clone the repository and install:

```sh
git clone https://github.com/Qbit-Org/qbit-wallet.git
cd qbit-wallet
corepack enable
pnpm install --frozen-lockfile
```

The Qbit SDK (`@qbit-oss/protocol`, `@qbit-oss/api`, `@qbit-oss/pqc`)
installs from npm, so no access beyond a normal clone is needed.

## Build and test

```sh
pnpm build        # build all packages
pnpm typecheck    # type-check all packages
pnpm lint         # lint the whole repository
pnpm test         # unit tests
```

Build the extension:

```sh
pnpm --filter qbit-extension build:chrome:mv3:dev   # development build
pnpm --filter qbit-extension build:chrome:mv3       # release build
```

Load the output folder as an unpacked extension in Chrome
(`chrome://extensions`, then **Developer mode**, then **Load unpacked**).

Run against a local Qbit network:

```sh
pnpm regtest:up
pnpm test:integration
pnpm test:e2e
pnpm regtest:down
```

See [`docs/regtest-harness.md`](docs/regtest-harness.md) for details.

## Make a change

1. Create a branch from `main` in your own copy of the repository.
2. Keep each pull request focused on one change.
3. Add or update tests for any behavior you change.
4. Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before you push.
5. Add a changeset if your change affects a package under `packages/` (see
   below).
6. Open a pull request against `main` and fill in the template.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(extension): show the fee rate on the send screen
fix(keyring-service): reject an empty password on unlock
docs: explain the regtest funding script
```

Every commit on `main` and `release/*` must carry a verified signature, and
pull requests merge with a merge commit: squash and rebase merges are off. You
don't need to sign your own commits. When a pull request is ready, a
maintainer squashes it into one commit, signs it and merges it. That commit's
message is the pull request's title and description, so write the title in
the same style. If you open the pull request from your own copy of the
repository, leave "Allow edits by maintainers" on, so the maintainer can push
the signed commit to your branch. Without it, a maintainer opens the same
change from a branch in this repository. An open pull request usually shows
a failing `signed-landing` check until it is one commit signed by a person,
normally the maintainer's squash. That is expected.

A release pull request, from `release/x.y.z` into `main`, and a back-merge,
from `main` into a release branch, are the exceptions. They merge as they
are, with a merge commit, and every commit in them must already carry a
verified signature.

### Changesets

If your change affects a workspace package under `packages/`, describe it
with a changeset:

```sh
pnpm changeset
```

Pick the affected packages, choose the bump type, and write a one-line summary
for the changelog. Commit the generated file in `.changeset/` with your
change. Docs-only and test-only changes do not need one.

The packages under `packages/` are private: changesets bump their versions
and write their changelogs, but they are not published to npm. The extension
(`qbit-extension`) is versioned by hand for each store release, so changesets
skip it. See [`docs/package-release.md`](docs/package-release.md).

### Wording check

A test scans every tracked file, including changesets and docs, for wording
that does not fit the project, such as references to other chains. It is
`scripts/security/fresh-chain-language.test.mjs`, and it runs in the
`Dependency policy` CI job as part of `pnpm test:security-tooling`. If it
fails, reword the flagged lines. You can run it locally:

```sh
pnpm test:security-tooling
```

## Review

- A ruleset on `main` requires one approving review, and the most recent
  push must be approved by someone other than the person who pushed it. New
  pushes dismiss earlier approvals.
- A second ruleset requires three status checks:
  `Typecheck, test, and build`, `Playwright G3 scenarios` and
  `signed-landing`. The other CI jobs, including `Lint` and
  `Dependency policy`, are not required, so reviewers check them before
  merging.
- Every change needs a review from one of the code owners listed in
  [`.github/CODEOWNERS`](.github/CODEOWNERS). Security-sensitive paths also
  have their own rules there: key management, signing, approvals,
  permissions, the provider API, build scripts, dependencies, and CI
  workflows. Expect a slower, more careful review for these.
- Repository and organization administrators can bypass the review rules
  when they merge a pull request, but not the status checks. AR-03 in
  [`docs/security/accepted-risks.md`](docs/security/accepted-risks.md) tracks
  this bypass; its entry still describes the wider one from before these
  rulesets and is updated when they are applied.
- Another ruleset requires a verified signature on every commit of `main`
  and `release/*`, and it has no bypass list.
- Release branches (`release/*`) have that signature rule, take changes
  through pull requests only, and require the `signed-landing` check. They
  require no approval. Their changes reach `main`
  through a pull request that the `main` rules apply to. Reconcile branches
  such as `release/1.0.8-reconcile-main` are left out of both rules.
- The rulesets are in [`.github/rulesets/`](.github/rulesets/), with how to
  apply them and check them against GitHub.
- Changes to keys, PQC, protocol, or signing code must fill in the
  counter-safety section of the pull request template.
- New dependencies need a clear reason. We keep the dependency set small and
  review every addition.

## Changes outside this repository

Some code lives in other repositories:

- Qbit protocol and API packages: `@qbit-oss/protocol` and `@qbit-oss/api`
  ([Qbit-Org/qbit-js](https://github.com/Qbit-Org/qbit-js))
- Post-quantum signing: `@qbit-oss/pqc`
  ([Qbit-Org/qbit-pqc](https://github.com/Qbit-Org/qbit-pqc))

The SDK packages are pinned in `scripts/security/sdk-package-pins.json`.
- Qbit Core node: [Qbit-Org/qbit](https://github.com/Qbit-Org/qbit)
- Indexer: [Qbit-Org/qbit-electrs](https://github.com/Qbit-Org/qbit-electrs)

Make changes there first. Once they are merged, open a pull request here that
updates the pinned version.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
