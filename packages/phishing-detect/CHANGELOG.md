# @qbit/phishing-detect

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
