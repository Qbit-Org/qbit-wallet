/**
 * Content Script Entry Point
 * Coordinates all content script modules
 */
import { isTopFrame } from './frame';
import { initializeScriptInjection } from './injection/scriptInjector';
import { initializePhishingDetection, setupPhishingListeners } from './phishing/detector';
import { holdDenylistedPage } from './phishing/hold';
import { allowLinksWithinProceededPage, setupNavigationListeners } from './phishing/navigation';

// Initialize phishing detection immediately
(async function initialize() {
  // The network rules keep frames off the denylist's hosts, so the content
  // script guards navigation from the top frame only, and a frame, even a
  // sandboxed ad, cannot send the whole tab to the warning page. A child
  // frame, such as an embedded widget, only checks its own host, so that a
  // frame on a host the bundled policy covers gets no provider.
  const guardsNavigation = isTopFrame();

  // Stop a page the bundled policy covers before any of its script runs: the
  // network layer may not have blocked it, and it never names a `qbit.<tld>`
  // lookalike that is not on the denylist.
  const heldPage = holdDenylistedPage();

  // Watch link clicks from the start, before any page script adds its own
  // listeners and before the first check answers.
  if (guardsNavigation) {
    setupNavigationListeners();
  }

  // Run initial phishing check
  const verdict = await initializePhishingDetection(guardsNavigation, heldPage !== undefined);

  // It reloads once the background lets it through.
  heldPage?.settle(verdict);

  // Expose the provider only on a page the background has cleared. A
  // denylisted page, even one the user proceeded to, or a page whose check
  // failed gets no wallet provider.
  if (verdict === 'clear' && !heldPage) {
    initializeScriptInjection();
  }
  if (verdict === 'proceeded') {
    allowLinksWithinProceededPage();
  }

  // Setup all listeners
  if (guardsNavigation) {
    setupPhishingListeners();
  }
})();
