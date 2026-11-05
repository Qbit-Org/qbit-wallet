# 1.0.8 release checks

Browser checks for the 1.0.8 release notes that the G3 gate
(`tests/e2e`) does not run. They reuse the gate's page objects and support
code, and run with their own Playwright config.

| Spec                         | Needs regtest | What it checks                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome-update.spec.ts`      | No            | A real update: each published release (1.0.5, 1.0.6, 1.0.7) is installed from its ZIP and set up through its own screens, then replaced by 1.0.8 in the same directory and profile. Wallets, accounts, contacts, sites, settings, the lock settings, Send and Receive. |
| `screen-sweep.spec.ts`       | No            | Every static screen in all six languages on 1.0.7 and 1.0.8. Fails on an uncaught error, error screen or console error that 1.0.8 adds; saves a screenshot of every screen for review.                                                                                 |
| `translations.spec.ts`       | No            | No translation key removed since 1.0.7 is still used, and every key the code uses exists in every language. (The shipped build logs no warning for a missing key, so the sweep cannot see one.)                                                                        |
| `lock-and-vault.spec.ts`     | No            | The Security switches, "Lock when all windows close" off and on, a lock during an unlock, and a vault entry of an unknown type ("Unsupported Wallet").                                                                                                                 |
| `sites-and-contacts.spec.ts` | No            | A site in a frame connects under its own origin, the page around it stays unconnected, a sandboxed frame gets no provider, a lost request fails with 4900; contact alias flag and duplicate refusal.                                                                   |
| `regtest.spec.ts`            | Yes           | `signPsbts`: different PSBTs sign in any order, the batch budget line, a second request refused while one is open, a lock ending the batch; New Address selecting the owning account.                                                                                  |
| `slow-upload.spec.ts`        | Yes           | A 24-input send whose submission takes past 1.0.7's 15 s budget (held by a slow-uplink proxy) still broadcasts.                                                                                                                                                        |

## Running

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test:e2e:build            # apps/extension/dist/chrome, as the gate uses

# The published release ZIPs, for chrome-update and screen-sweep.
mkdir -p .context/releases && for tag in v1.0.5 v1.0.6 v1.0.7; do
  gh release download "$tag" -R Qbit-Org/qbit-wallet -p '*.zip' -D .context/releases --clobber
done

# QBIT_E2E_HEADLESS=1 keeps the browser off the screen.
QBIT_E2E_HEADLESS=1 QBIT_UPGRADE_RELEASES_DIR=.context/releases \
QBIT_UPGRADE_TARGET_DIR=<the 1.0.8 build to update to> \
  corepack pnpm exec playwright test -c tests/release-1.0.8/playwright.config.ts
```

`QBIT_E2E_EXTENSION_DIR` points the other specs at an unpacked build other
than `apps/extension/dist/chrome` (the regtest specs need the e2e build).

The offline specs run in parallel (`QBIT_RELEASE_WORKERS`, default 6); the
regtest specs share the regtest node and run one at a time beside them. The
screen sweep is one test per language, each sweeping 1.0.7 and 1.0.8 in two
browsers at once.

`QBIT_UPGRADE_TARGET_DIR` defaults to `apps/extension/dist/chrome`. Its
manifest must say a version above 1.0.7: Chrome does not treat an unpacked
directory replaced under the same version as an update, and runs the
release's stored service worker over it.

Playwright clears the output directory at the start of a run. To run two of
these at once, give each its own with `--output`.

## Known limits

- Locking the computer, and sleep counting toward auto-lock, cannot be
  triggered from a test: Chrome reports both only from the operating system.
- `chrome-update.spec.ts` removes the profile's `Service Worker` directory
  between the release and 1.0.8. Chrome otherwise starts the release's
  stored script for the replaced directory, with no listeners; a Web Store
  update registers the new script itself.
- The signature budget is about 2^30 per key, so a batch that needs more
  signatures than remain cannot be reached here; unit tests cover it.
