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
  // MV3's network rules keep frames off denylisted hosts, so there the
  // content script guards navigation from the top frame only. A child frame,
  // such as an embedded widget, only checks its own host, so that a
  // denylisted frame gets no provider. MV2 has no such rules and guards
  // every frame.
  const guardsNavigation = isTopFrame() || process.env.manifest !== 'mv3';

  // Stop a denylisted page before any of its script runs, in case the
  // network layer did not block it.
  const heldPage = holdDenylistedPage();

  // Watch link clicks from the start, before any page script adds its own
  // listeners and before the first check answers.
  if (guardsNavigation) {
    setupNavigationListeners();
  }

  // Run initial phishing check
  const verdict = await initializePhishingDetection(guardsNavigation);

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
