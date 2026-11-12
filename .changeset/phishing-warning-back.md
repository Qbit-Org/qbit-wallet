---
'@qbit/wallet-background': patch
---

Back from the phishing warning page now returns to the page before a phishing page that the content script held. Such a page is a `qbit.<tld>` lookalike that no network rule names, reached by a typed address, a bookmark or a redirect. The warning page comes after the held page in the tab's history, so Back loaded that page again, and the background sent it to the warning page again, every time.

`REDIRECT_TO_PHISHING_PAGE` now takes `fromHistory: true`, which the content script sends for a held page loaded with Back or Forward. The controller then takes the tab back past the page with `chrome.tabs.goBack` and answers `{ success: true, wentBack: true }`. It answers `{ success: false, skipped: true }`, and does nothing, when the page that asked is no longer the tab's page, when the tab is loading another page, or when the tab is already being taken back. It sends to the warning page as before:

- a tab with no earlier page;
- a tab it took back since it last sent that tab to the warning page, where the user went Forward or the page before went forward by itself;
- a request from a frame or without a document.

It keeps the record of tabs it took back only while its service worker runs.
