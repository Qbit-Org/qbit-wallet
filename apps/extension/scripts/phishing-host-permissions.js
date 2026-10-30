/* eslint-env node */

const { BUNDLED_PHISHING_DENYLIST, dnrHostPermissions, partitionDnrDomains } = require('@qbit/phishing-detect');

/**
 * The host permissions that let the phishing `redirect` rule send a top-level
 * navigation to the wallet's warning page: one `*://*.<domain>/*` pattern,
 * which covers the domain and its subdomains, for each domain the DNR rules
 * name. A DNR `redirect` fires only with host access to the request URL; the
 * `block` rule needs none. The background checks the same patterns before it
 * installs the rule. The content script already matches `<all_urls>`, so these
 * add no install-time warning.
 */
function phishingHostPermissions(entries) {
  return dnrHostPermissions(partitionDnrDomains(entries).domains);
}

/** The host permissions for the denylist bundled with this release. */
function bundledPhishingHostPermissions() {
  return phishingHostPermissions(BUNDLED_PHISHING_DENYLIST);
}

module.exports = {
  bundledPhishingHostPermissions,
  phishingHostPermissions
};
