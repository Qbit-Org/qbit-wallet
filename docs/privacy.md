# Qbit Wallet privacy and network behavior

Last reviewed against the production source on 2026-09-04. The local-storage, audit-scope and reporting sections were rechecked on 2026-10-23.

This is an engineering description of what the browser extension does today. It is not a promise that a website, browser, extension store, chain API, explorer, or other service outside this repository follows the same practices.

## Summary

Qbit Wallet does not send analytics, crash reports, install pings, device identifiers, wallet-identifier telemetry headers, remote notification read receipts, or website-safety queries. Wallet configuration and website-safety policy are bundled with each extension release.

The wallet still needs network access for chain data and transaction broadcast. Those requests expose ordinary network metadata, including the user's IP address, to the configured endpoint operator. Address, transaction, outpoint, public-key, recipient, amount, fee, or raw-transaction data may also be present when required by the requested wallet action. Seed phrases, private keys, the wallet password, and signing keys are not sent to those endpoints.

## Automatic network destinations

The production chain matrix is defined in `packages/wallet-shared/src/constants/common.ts`.

| Network | Chain API base | Explorer base |
| --- | --- | --- |
| Qbit Mainnet | `https://mempool.qbit.org/api` | `https://mempool.qbit.org` |
| Qbit Testnet4 | `https://mempool-testnet.qbit.org/api` | `https://mempool-testnet.qbit.org` |
| Qbit Regtest | `http://127.0.0.1:3002` (optional, off by default; see below) | None |

The repository configures Mainnet at `mempool.qbit.org` and Testnet4 at `mempool-testnet.qbit.org`, but does not establish the legal operator, production logging, or retention policy for either destination. That is a deployment-level privacy uncertainty and must be resolved separately from the client-side controls documented here.

Normal automatic wallet requests stay below the selected chain API base. They include the requests needed for balances, UTXOs, history, fee estimates, transaction status, block data used by the UI, and transaction broadcast. Mainnet and Testnet4 use the configured mempool-qbit API; Regtest uses the loopback Esplora API, and only after the optional local connection has been enabled (see below).

Explorer URLs are opened only after a user action, such as viewing an address, block, or transaction. The identifier being viewed is part of the explorer URL.

The extension code does not add persistent device IDs or wallet-specific `x-address`, `x-channel`, `x-client`, `x-udid`, `x-udid2`, or `x-version` telemetry headers. Standard browser networking still exposes an IP address and may add normal browser headers.

## Optional local Regtest connection

Regtest is a developer testing network whose coins have no monetary value. The Chrome Web Store build does not have access to the local Regtest service by default:

- The manifest lists only the Mainnet and Testnet4 explorer origins as required host permissions. The loopback origin `http://127.0.0.1:3002/*` is declared as an *optional* host permission (`optional_host_permissions`) and the extension-page CSP `connect-src` names the exact origin `http://127.0.0.1:3002`. No wildcard hosts, no other loopback ports, and no `localhost` hostname are declared.
- The browser permission is requested only when the user selects the **Local Regtest** network row in Network settings, or **Local Regtest → Enabled** in Advanced settings, reads the explanation, ticks the acknowledgement, and presses **Enable**. Opening settings never triggers a prompt, and a website or dapp cannot trigger one: a dapp `switchChain`/`switchNetwork` request for regtest is rejected with "Regtest access has not been enabled" while the feature is off.
- The acknowledgement is stored as a version tag (`regtest_access_ack_v1`) in extension-local storage. It is consent bookkeeping only; the wallet re-reads `chrome.permissions.contains()` every time regtest is entered.
- Before switching, at startup with a persisted regtest selection, and on explicit retry, the background performs a bounded read-only identity check against the fixed origin: `GET /block-height/0` must return, as `text/plain`, the reviewed Qbit regtest genesis hash, and `GET /blocks/tip/height` must return a block height. The probe uses a short timeout, a small response-size cap, no credentials and no redirects, and sends no addresses, keys, or transaction data. A wrong or missing answer keeps the wallet on its current public network.
- While Regtest is the active network, the normal wallet requests described above (balances, UTXOs, history, fee estimates, transaction status and broadcast) go to the local service instead of a public explorer, so the local process can observe the addresses, outpoints, and raw transactions involved. Seed phrases, private keys, the wallet password, and signing keys are never sent to it.
- Testnet4 and Regtest share a derivation path, so a Testnet4 wallet restore reconstructs its signature-counter floors from both histories when it can. The Regtest history is consulted only when the local connection is enabled and the identity check above has just passed; otherwise the restore uses Testnet4 alone and sends nothing to the loopback port. Mainnet restores never consult it.
- Choosing **Disabled** under **Local Regtest** in Advanced settings switches back to Mainnet and clears the acknowledgement; from then on regtest is locked and every entry re-asks for consent. It does not call `chrome.permissions.remove()`: Chrome rejects removing this origin through the API because the extension's content script matches `<all_urls>`, which makes the loopback pattern a required scriptable host. The granted permission therefore stays listed in Chrome's extension settings until the user removes it there. Removing it there locks the wallet's regtest access as well: the wallet returns to Mainnet immediately and no client remains bound to the loopback endpoint.

This check detects an accidental wrong service and basic impersonation. It is not authentication: another local process could emulate the API and the expected genesis response.

## Local-only features

The following features do not make a remote request:

- Website-safety and phishing-list checks.
- Wallet feature configuration and release flags.
- Discovery catalog, banners, and application summaries.
- Announcements, notification content, notification read state, and version-detail notices. Extension updates are left to the browser's extension-store mechanism; the explicit update link is opened only when selected by the user.
- Locale-file and WASM loading, which use resources bundled inside the extension.
- Dapp icons shown in approval and connected-site UI; the wallet displays its bundled icon instead of loading a URL supplied by a website.

The content script does not wrap or inspect a page's `fetch` or `XMLHttpRequest` traffic. It communicates provider requests and local phishing decisions through extension messaging.

## Website-safety decisions

Approval flows use three explicit verdicts:

- `blocked`: the normalized hostname exactly matches, or is a subdomain of, an entry in the bundled denylist. Approval cannot continue.
- `clear`: the input is a well-formed public HTTPS origin, the local detector completed, and the hostname is not in the bundled denylist.
- `unverified`: the input is malformed, uses credentials/path/query/fragment where an origin is required, uses non-HTTPS transport, is localhost or a literal/private/special network target, uses a private-network suffix, times out, or cannot be evaluated because the detector failed.

An `unverified` result is not represented as safe. Connect, message-signing, PSBT-signing, and `sendQbit` approvals show a warning with Retry and Reject actions. Continuing requires an explicit acknowledgement. A `blocked` result has no continue action. If a check times out, a later clear result cannot silently replace the warning; a late blocked result still upgrades the prompt to blocked.

The content-script navigation warning has a separate local user bypass list. That list does not turn an approval verdict into `clear` and does not override the approval guard.

### Static denylist provenance and updates

The denylist is bundled in `packages/phishing-detect/src/static-policy.ts`. Policy version `qbit-static-v1` was reviewed from `unisat-wallet/phishing-detect` commit `62078d24175a1af12715e5acaa2b8cbf77abda03`, file `phishing_sites.json`, Git blob `0f2812cb5f7c5ae1b188daa7ba7660b9ffd860fb`. License and attribution details are in `packages/phishing-detect/THIRD_PARTY_NOTICES.md`.

The policy is not refreshed at runtime. A change requires a reviewed source update, tests, and a new extension release. Reserved remote-policy keys are normalized to `null` during detector initialization and are never used for decisions.

### Known limits

- `clear` means only that the local checks above completed; it is not a guarantee that a website is trustworthy.
- The bundled list can become stale between extension releases and does not cover every malicious or newly registered domain.
- Matching is deterministic exact-host/subdomain matching. There is no fuzzy or visual-homograph detection.
- The detector performs no DNS lookup. A public-looking hostname that later resolves to a private address, or changes address through DNS rebinding, is not classified from its DNS result.
- The local/private checks cover literal IP ranges and selected special-use suffixes; an organization can use other internal naming schemes that the wallet cannot identify locally.

## Local storage

The extension uses browser extension-local storage, not browser sync storage, for wallet state and preferences. The keyring vault, including software-wallet secret material, is encrypted with the wallet password before persistence. Other local records include connected-site permissions and origins, account preferences, contacts, cached public chain data, locally stored notification state, and the navigation-warning bypass list.

The wallet UI also writes the extension pages' `localStorage`, unencrypted and on the device only:

- `redux_localstorage_simple_ui`: the persisted `ui` slice of the wallet state (`packages/wallet-state/src/index.ts`), which holds the send-screen draft (recipient address, amount, memo and RBF choice), the address and amount inputs, the fee-rate selection, the hidden-balance and balance-detail toggles, and the navigation source;
- `themeMode`: the light or dark theme;
- `i18nextLng` and `userSelectedLanguage`: the interface language and whether the user chose it;
- `version_detail`: the last extension version whose bundled version notice was seen or dismissed;
- `ecosystem_warning_acknowledged`: whether the ecosystem warning was acknowledged; and
- `@announcement_dismissed_ids`: the bundled announcements the user dismissed.

None of these keys holds a seed phrase, private key or password.

The wallet password and decrypted key material exist in extension memory while needed for an unlocked wallet. Locking the wallet clears the in-memory password and unlocked keyrings. Removing the extension or clearing its extension data is controlled by the browser; browser backups and device-level storage behavior are outside this repository.

## Dapps and user-initiated navigation

The extension runs a content script on web pages so a dapp can discover the Qbit provider and request access. A dapp receives an account address only after the user approves connection. Requested messages, PSBTs, transaction parameters, and returned signatures are exchanged with that requesting page through extension messaging. Signing is local; broadcasting a signed transaction contacts the selected chain API.

The wallet contains explicit links to Qbit websites, configured explorers, the source repository, social/community sites, documentation, and a release-owned local dapp catalog. Following one of those links leaves the extension and gives the destination the normal data associated with a browser visit. Dapps can also make their own network requests independently of the wallet.

## Enforcement and audit scope

`apps/extension/scripts/privacy-source-guard.js` scans shipped app and package source and fails on disallowed remote website/config and phishing routes, notification/version/announcement routes, identifying header names, generated device-ID vocabulary, and dapp-controlled session-icon loading. Seeded tests prove every rule detects a violation.

`apps/extension/scripts/runtime-network-audit.test.js` drives one HTTP stack, the qbit-js chain client (`MempoolQbitClient` for Mainnet and Testnet4, `EsploraClient` for Regtest), through five calls on each network: address stats (balance), UTXOs, transaction status, fee estimates, and broadcast. It asserts exactly 15 requests, requires every request to remain beneath the exact configured chain API base, and checks the generated explorer address, block, and transaction URLs. It does not cover history or signing-support requests, and it does not exercise the extension's own HTTP client (`apps/extension/src/background/utils/http-client/httpClient.ts`) or the `@qbit/wallet-api` client (`packages/wallet-api/src/client/http-client.ts`). The `/v5/default/check-website` and `/v5/default/config` routes are rejected only by the static source guard above.

The audit is deterministic and does not contact live services. It verifies routing behavior in the wallet clients; it does not make claims about browser-store update traffic, a destination's server-side retention, user-selected websites, or requests made independently by a connected dapp.

Report security or privacy vulnerabilities privately as described in [SECURITY.md](../SECURITY.md), not in a public issue. Never include seed phrases, private keys, passwords, or other wallet secrets in a report.
