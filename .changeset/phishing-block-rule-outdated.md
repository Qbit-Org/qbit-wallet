---
'@qbit/wallet-background': patch
'@qbit/wallet-shared': patch
---

Name an outdated block rule in the phishing protection report. While the block rule is `installing`, `retrying` or `failed` and a block rule an earlier install left still blocks some domains (`blockedDomains` above 0), `protection.reasons` now lists the new `PhishingProtectionReason` `block-rule-outdated` in place of `block-rule-not-installed`. `block-rule-not-installed` stays for a block rule that blocks no domain, or whose domains could not be read. Protection stays `degraded` in both cases, and `site-access-withheld` or `site-access-unknown` follow either reason, since the earlier rule does not cover the current list.
