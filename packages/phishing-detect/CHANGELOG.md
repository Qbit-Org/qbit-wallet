# @qbit/phishing-detect

## 0.4.0

### Minor Changes

- 4091176: Retry a failed phishing block rule install and report its health (#48). Before, when `updateDynamicRules` failed at service-worker start, the error was only logged: the denylist had no network layer until the next start, and an upgraded profile kept the inert redirect rules of 1.0.4. `PhishingController` now retries the install after 1, 4 and 15 seconds, then every minute while the service worker runs, up to ten attempts. After each failure it removes every dynamic rule but a block rule on its own, so those redirect rules cannot linger, and keeps a block rule an earlier install left. A successful install counts only once the browser reads the rule back with every domain, and a worker start that finds that rule already in place, alone, leaves it as it is. `GET_PHISHING_STATS` also answers `networkRules`, the rule's health: `installing`, `installed`, `retrying`, `failed`, `unknown` or `unsupported`, with the attempts, the last error, the next retry, the number of domains the browser holds and the denylist entries left out. An `installed` state is checked against the browser's rules at each read, so it is never a stale one, and a rule found missing reads as `retrying` and is installed again. An install that a newer one supersedes answers with the newer one's outcome. `GET_PHISHING_STATS` is now answered only for the wallet's own pages, like the other messages that lift or reload protection. `FORCE_UPDATE_PHISHING_LIST` now also installs the rule again through `forceUpdate()`, which rejects, and so the message answers `{ error }`, when the rule is not installed after its first attempt.

  In `@qbit/phishing-detect`, `parseDnrDomain()` and `partitionDnrDomains()` are new. They return the form a DNR rule's `requestDomains` takes, or why an entry cannot go in one (`not-a-string`, `empty`, `non-ascii` or `not-a-public-hostname`), so the extension leaves out and logs a bad entry rather than letting it fail the whole rule.

  `@qbit/wallet-shared` exports the health type as `PhishingNetworkRuleHealth`.

  The extension's content script now stops a top-frame page whose host the bundled denylist covers before the page's own script runs, until the background answers. A page sent to the warning page stays stopped, and one whose check does not complete shows a notice with a retry. A page the user proceeded to is recorded in its sessionStorage and reloaded once. A page whose sessionStorage cannot be used, such as a sandboxed one or one whose site data is blocked, stays held, and a page held again on a reload is not reloaded once more without the user asking.

- 4091176: Show the wallet's phishing warning, with Proceed, for a top-level navigation to a denylisted host however the tab got there, including a redirect or link wrapper (#9). Before, only a link the content script saw first led to the warning; a same-site 302, `t.co`, a mail safe-link, a typed URL or a bookmark ended on the browser's generic blocked page (`ERR_BLOCKED_BY_CLIENT`). `PhishingController` now keeps a session DNR `redirect` rule, above the block rule and below Proceed's allow rules, that sends such a navigation to the web-accessible `phishing-warning.html` with the blocked URL in its fragment; that page validates the URL and replaces itself with the warning screen. A redirect fires only with host access, so the rule is in place only while `chrome.permissions.contains` reports access to every denylisted domain: it is removed when the user withholds site access, added back when access returns, checked again at each service-worker start and forced list update, and a failed update is retried after 1, 4 and 15 seconds, then every minute while the service worker runs, up to ten attempts per change, or for as long as a removal fails. The block rule stays for frames and as the fallback. Proceed's allow rules now take priority 3. `hasOnlyKeys` and `sameMembers` are shared from `phishing-block-rule.ts`.

  The extension's MV3 manifest requests `*://*.<entry>/*` for each bundled denylist domain, generated at build and pinned by the package policy, and lists `phishing-warning.html` as web-accessible under a per-session dynamic URL only. The content script's `<all_urls>` match already brings the all-sites install warning, so these add no new one. The warning screen offers no Proceed when it names no site.

  In `@qbit/phishing-detect`, `dnrHostPermissions()` is new. It returns the host permission patterns (`*://*.<domain>/*`, or the exact address for an IP) that cover DNR domains and their subdomains, which the manifest declares and the background checks.

### Patch Changes

- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
- Updated dependencies [4091176]
  - @qbit/wallet-shared@2.0.0

## 0.3.0

### Minor Changes

- 6f06a0b: Treat a denylisted host as denylisted whatever its DNS label syntax (#335). `PhishingService.checkWebsite()` now checks the bundled denylist before classifying the rest of an http(s) origin. A denylisted host is therefore always `BLOCKED`, even when its origin uses HTTP, has a path, or has a label outside DNS syntax such as `a_b.<entry>`. Before, those origins were only `UNVERIFIED`, so an approval showed a warning the user could acknowledge.

  `PhishingService.isDenylisted(hostname)` is new. It reports whether the bundled denylist covers a hostname, and it ignores navigation bypasses and DNS syntax.

  `PhishingController` now answers the `isDenylisted` field of `CHECK_PHISHING` with `isDenylisted()`. Before, after Proceed on a denylisted host, a subdomain such as `a_b.<entry>` loaded with the wallet provider, because the old check accepted only hostnames in DNS syntax. Proceed and the DNR block rule still accept only well-formed public hostnames, which DNR requires.

### Patch Changes

- 6f06a0b: Make MV3 phishing blocking take effect (#266). `PhishingController` now installs one dynamic `declarativeNetRequest` `block` rule whose `requestDomains` are the bundled denylist, for `main_frame` and `sub_frame` requests. The earlier per-domain `redirect` rules needed host access to every denylisted host, which the manifest does not grant, so they never fired. The update replaces every existing dynamic rule in one call, including those redirect rules. `SKIP_PHISHING_PROTECTION` (Proceed) now adds a session-scoped `allow` rule for top-level (`main_frame`) requests to the host and its subdomains at a higher priority than the block rule, so other sites still cannot frame the host. It answers `{ success: true }` only once the rule is in place. It answers `{ error: 'Invalid hostname parameter' }` for a hostname that is malformed or not covered by the bundled denylist, and `{ error }` when the rule update fails. After a service-worker restart, the controller restores the in-memory bypass from those session rules before it answers `CHECK_PHISHING`, `REDIRECT_TO_PHISHING_PAGE` or `CHECK_NAVIGATION`, so a page the user proceeded to is not sent back to the warning page. `CHECK_PHISHING` also answers `isDenylisted`, which ignores Proceed, and the extension injects its provider only when both `isPhishing` and `isDenylisted` are `false`. If a denylist entry is not a canonical hostname, it is left out of the block rule and logged, because DNR would reject the whole rule. Both redirect messages now pass the blocked URL to the warning page as `href` only when it is an http(s) URL on the warned host, and an empty `href` otherwise.

  In `@qbit/phishing-detect`, an `addToWhitelist()` bypass now also covers subdomains of the host, matching the DNR rule, and an empty hostname is ignored. `checkWebsite()` still ignores every bypass.

- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
- Updated dependencies [6f06a0b]
  - @qbit/wallet-shared@1.2.0

## 0.2.3

### Patch Changes

- Updated dependencies [5c63999]
  - @qbit/wallet-shared@1.1.1

## 0.2.2

### Patch Changes

- Updated dependencies [8366980]
- Updated dependencies [0abd814]
- Updated dependencies [0a7576c]
  - @qbit/wallet-shared@1.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [a1458e0]
- Updated dependencies [f1bb656]
- Updated dependencies [b2a1b1a]
- Updated dependencies [688e9cb]
- Updated dependencies [213b242]
- Updated dependencies [3f39e95]
- Updated dependencies [a63aaf3]
- Updated dependencies [a25cee5]
- Updated dependencies [3c57bcf]
- Updated dependencies [64cc0ee]
- Updated dependencies [c83de12]
- Updated dependencies [917a499]
- Updated dependencies [0cd8709]
  - @qbit/wallet-shared@1.0.0

## 0.2.0

### Minor Changes

- release: minor wave for accumulated package updates.

## 0.1.3

### Patch Changes

- release: publish unpublished packages and ship accumulated fixes/features since latest npm versions.

## 0.1.2

### Patch Changes

- fix

## 0.1.1

### Patch Changes

- feat: add new package @qbit/phishing-detect
