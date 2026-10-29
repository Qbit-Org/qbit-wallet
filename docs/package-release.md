# Package Release Flow

This document describes how to version the packages under `packages/`. It uses
Changesets for versions and changelogs, and uses the local impact script to
decide which related packages need review before release.

> **The packages are not published.** Every package under `packages/` is
> `"private": true`, and `.changeset/config.json` sets
> `privatePackages.version: true` and `privatePackages.tag: false`, so
> Changesets still bumps their versions and writes their changelogs, but
> creates no tags and `changeset publish` skips them. This project does not
> own the `@qbit` scope on npm (#289); publishing waits for an npm scope
> decision (#96). Do not remove `private` or add `publishConfig` before then.
>
> **Do not run `changeset publish`.** No workflow runs it. The SDK packages
> (`@qbit-oss/pqc`, `@qbit-oss/protocol`, `@qbit-oss/api`) are npm
> dependencies, not workspace packages: they are versioned and published from
> the `Qbit-Org` repositories, so do not add changesets for them. A wallet
> package whose SDK dependency moves gets its own changeset.
>
> The extension (`qbit-extension`) is in the Changesets `ignore` list. It is
> versioned by hand for each Chrome Web Store release, so a package bump never
> moves it.

## 1. Check Changed Packages

For current worktree changes:

```sh
pnpm affected:packages
```

For a branch-level release check against `main`:

```sh
pnpm affected:packages -- --since main
```

The script reports:

- packages changed under `packages/`
- direct dependents to check
- transitive dependents to consider
- changed files used for the report

Use the output as the review checklist. Direct dependents are the first packages
to inspect. For low-level contract packages, also inspect transitive dependents.

## 2. Decide Version Bumps

Do not mechanically copy one package's `patch`, `minor`, or `major` bump to
dependent packages. Choose each package's bump based on that package's own
public API and behavior.

| Change type | Bump |
| --- | --- |
| Bug fix, internal implementation change, dependency metadata update | `patch` |
| Non-breaking public API or behavior addition | `minor` |
| Breaking public API or behavior change | `major` |

Downstream packages usually need a release only when one of these is true:

- their code changed
- their public API or behavior changed
- their package metadata should move forward with an internal dependency update
- they need integration work for a dependency change

`wallet-background` has broad `peerDependencies`, so treat service or shared
contract changes as integration-impacting and test it when the script reports it.

## 3. Add Changesets

Create a changeset:

```sh
pnpm changeset
```

Select every package whose version should move and choose the correct bump
for each one. The generated file in `.changeset/` should explain the user-facing or
package-consumer-facing reason for the release.

For dependency-only downstream releases, use `patch` unless that downstream
package also exposes new or breaking behavior.

Changesets is configured with:

```json
"updateInternalDependencies": "patch"
```

That means packages included in the same changeset can receive patch-level
internal dependency updates when needed.

## 4. Verify Before Versioning

Run focused checks for the changed and affected packages. For broad package
changes, run the workspace-level checks:

```sh
pnpm -r typecheck
pnpm -r test
pnpm build
```

If a package has special build behavior, run its package script directly. For
example, `wallet-core` uses `build:all` in `prepublishOnly`.

## 5. Apply Versions

After changesets are reviewed and checks pass, apply package versions and
changelogs:

```sh
pnpm changeset version
```

Review the generated changes before committing:

```sh
git diff
```

This step updates package versions, internal dependency ranges when needed, and
package changelogs.

On `main`, the Release workflow (`.github/workflows/release.yml`) runs
`pnpm run version-packages` and opens or updates the Version Packages pull
request with the result.

## 6. Publishing

Nothing is published to npm while the packages are private, and
`changeset publish` must not be run; see the notes at the top of this
document. Check what a version run would change with:

```sh
pnpm changeset status --verbose
```

## 7. Chrome Web Store: optional loopback permission

The store artifact declares `http://127.0.0.1:3002/*` under
`optional_host_permissions` and names `http://127.0.0.1:3002` in the
extension-page CSP `connect-src`. Required `host_permissions` hold the two
public explorer origins and the phishing denylist entries described in
section 8. When filling in the Web Store listing and the privacy/permission
justification, describe the loopback permission as follows:

- **What it is for**: an advanced developer feature, *Local Regtest*, that lets
  the wallet talk to a Qbit regtest indexer the user runs on their own machine.
  Regtest coins have no monetary value.
- **When it is requested**: only after the user selects the **Local Regtest**
  network row in Network settings (or **Local Regtest → Enabled** in Advanced
  settings), reads the in-app explanation, ticks the acknowledgement, and
  presses **Enable**. The request is made from
  that button's click handler; nothing requests it automatically and websites
  cannot trigger it.
- **What is sent**: while Regtest is active, ordinary wallet API requests
  (balances, UTXOs, history, fees, transaction status, broadcast) go to the
  local service. The identity probe run before switching sends no wallet data.
  Seed phrases, private keys and passwords are never sent.
- **How it is revoked**: choosing **Disabled** under **Local Regtest** in
  Advanced settings clears the in-app consent and returns to Mainnet; the
  browser permission itself is revoked from Chrome's extension controls (the
  API cannot remove it because the `<all_urls>` content script makes the
  origin a required scriptable host), and revoking there returns the wallet
  to Mainnet immediately.

## 8. Chrome Web Store: phishing denylist host permissions

The store artifact also declares `*://*.<entry>/*` under `host_permissions`
for each domain on the bundled phishing denylist. The build generates them
from `BUNDLED_PHISHING_DENYLIST`, and `package-artifact-validation.js` pins the
reviewed list by its length and SHA-256
(`REVIEWED_PHISHING_HOST_PERMISSIONS_COUNT` and
`REVIEWED_PHISHING_HOST_PERMISSIONS_SHA256`), so a denylist change fails
packaging until it is reviewed and both pins are updated too. The listing will
show these phishing domains among the extension's sites. Describe them as
follows:

- **What they are for**: a `declarativeNetRequest` `redirect` rule sends a
  top-level navigation to a known phishing domain, including one reached
  through a redirect or link wrapper, to the wallet's own warning page, which
  explains the block and lets the user proceed. Chrome fires a redirect only
  with host access to the site; the `block` rule that stops these sites
  otherwise needs none, but shows only the browser's generic error page.
- **What is accessed**: nothing is fetched from or injected into those sites
  beyond what the `<all_urls>` content script already does; the access lets
  the redirect fire.
- **Install warning**: none added. The content script's `<all_urls>` match
  already brings "Read and change all your data on all websites", and
  `chrome.management.getPermissionWarningsByManifest` reports that same single
  warning with and without these entries.

`corepack pnpm --filter qbit-extension run package:test -- --artifact-version <version>`,
with the extension's version (for example `1.0.6`), fails the build if
the generated manifest's required, optional, or CSP loopback entries, or its
phishing host permissions and web-accessible resources, differ from the
reviewed values, so inspect the packaged `manifest.json` (not only
`build/_raw/manifest/_base_v3.json`) before submission. See
`docs/privacy.md` ("Optional local Regtest connection") for the user-facing
data-flow description.
