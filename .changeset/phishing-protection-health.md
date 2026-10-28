---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
---

Report the phishing network layer as a whole, and leave the source tab alone for a link that opens a new tab where the warning redirect rule already shows the warning.

`GET_PHISHING_STATS` now also answers `protection` when DNR is available: `degraded` while the block rule is not installed, or while a redirect rule that cannot fire for lack of host access may still be in place because its removal is pending or failing; `unknown` while either rule cannot be read; and `full` otherwise. It lists the reasons, including `site-access-withheld` when the block rule is not installed and site access is withheld, and the warning redirect rule's own state (`installed`, `not-wanted`, `missing`, `removing`, `removal-failed` or `unknown`) with its host access, last error and next retry, read back from the browser. Before, the health covered only the block rule and reported `installed` while such a redirect rule was still in place. A read that finds that rule with no retry scheduled starts its removal. `networkRules` is unchanged, and an MV2 answer has no `protection`.

`CHECK_NAVIGATION` takes an optional `newTab` flag, which the content script sets for a `_blank` link and for a Ctrl-, Cmd- or Shift-click. When the redirect rule is in place with host access for the link's canonical host, the background leaves the sending tab and its page alone and answers `leftToRedirectRule: true`; otherwise it sends that tab to the warning page as before.

In `@qbit/wallet-shared`, the types `PhishingProtectionHealth`, `PhishingProtectionStatus`, `PhishingProtectionReason`, `PhishingWarningRedirectHealth`, `PhishingWarningRedirectStatus` and `PhishingStatsResponse` are new.

The extension's warning screen offers Proceed only for a hostname that passes `parseDnrDomain`, the check the background applies to Proceed; for any other it says that the site cannot be opened from there, rather than failing with an unknown error.
