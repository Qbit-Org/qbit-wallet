/**
 * Content Script Entry Point
 * Coordinates all content script modules
 */
import { initializeScriptInjection } from './injection/scriptInjector';
import { initializePhishingDetection, setupPhishingListeners } from './phishing/detector';
import { holdDenylistedPage } from './phishing/hold';
import { allowLinksWithinProceededPage, setupNavigationListeners } from './phishing/navigation';

// Initialize phishing detection immediately
(async function initialize() {
  // Stop a denylisted page before any of its script runs, in case the
  // network layer did not block it.
  const heldPage = holdDenylistedPage();

  // Watch link clicks from the start, before any page script adds its own
  // listeners and before the first check answers.
  setupNavigationListeners();

  // Run initial phishing check
  const verdict = await initializePhishingDetection();

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
  setupPhishingListeners();
})();
