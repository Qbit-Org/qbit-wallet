---
'@qbit/phishing-detect': minor
---

Replace the bundled phishing policy with one Qbit owns, `qbit-static-v2`, aimed at sites that imitate the official website, https://qbit.org. The 29 third-party domains of `qbit-static-v1` are gone. A `qbit.<tld>` host under any top-level domain other than `org`, or a subdomain of one, now counts as phishing in `checkPhishing()`, `isDenylisted()` and `checkWebsite()`, except special-use names such as `qbit.localhost` and `qbit.test`. `qbit` must be the label right before the top-level domain, so `qbit.co.uk` and `qbit.<site>.com` are not covered. `BUNDLED_PHISHING_DENYLIST`, which the extension's network rules and host permissions name, is now `qbit.ca`, `qbit.com`, `qbit.io` and `qbit.me`; the page hold and the wallet's own checks catch the other lookalikes. New exports: `findQbitLookalikeDomain()`; `findBundledPolicyMatch()`, which the extension's content script uses to match as the background does; `TRUSTED_WEBSITE_ORIGIN`; and `isSpecialUseHostname()`.

`checkWebsite('https://qbit.org')` now returns a `clear` verdict with reason `trusted` and `allowQuickMultiSign: true`. Only that exact origin is trusted, not its subdomains, another port or HTTP.

`BundledPhishingPolicyMetadata` keeps only `policyVersion` and `reviewedAt`, and `PhishingConfig` no longer has `sourceRevision`. `THIRD_PARTY_NOTICES.md` is removed, as the package no longer bundles third-party data.
