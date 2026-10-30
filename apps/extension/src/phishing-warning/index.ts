import { phishingWarningPath } from './warningRoute';

// The phishing redirect rule opens this page in place of a top-level page on
// a denylisted host, with that page's URL as the fragment. It is
// web-accessible only under a per-session URL, so a website cannot open it
// itself; in a frame it does nothing all the same. Replacing it keeps it out
// of the tab's history.
if (window.top === window) {
  window.location.replace(chrome.runtime.getURL(phishingWarningPath(window.location.hash)));
}
