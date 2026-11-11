/**
 * Phishing detection module
 * Handles phishing site detection and redirection
 */
import { forgetRelease } from './release';

export function isExtensionContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * The background's verdict for the current page. 'proceeded' is a denylisted
 * host whose warning the user chose to skip. 'unknown' means the check did not
 * complete, for example because the extension was reloaded.
 */
export type PhishingVerdict = 'phishing' | 'proceeded' | 'clear' | 'unknown';

/**
 * How the browser reports this page's load: `navigate`, `reload`,
 * `back_forward` (Back or Forward) or `prerender`, or undefined when it
 * reports none.
 */
export function navigationType(): string | undefined {
  try {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    return entry?.type;
  } catch {
    return undefined;
  }
}

function requestWarningPage(hostname: string, pageHeld: boolean): void {
  if (!isExtensionContextValid()) return;
  try {
    chrome.runtime.sendMessage(
      {
        type: 'REDIRECT_TO_PHISHING_PAGE',
        hostname,
        // Proceed returns to this exact URL instead of the bare hostname.
        url: window.location.href,
        // A held page reached with Back or Forward, as from the warning page:
        // the background takes the tab back past it instead, as a warning page
        // in a new entry would leave this page for Back to load again.
        ...(pageHeld && navigationType() === 'back_forward' ? { fromHistory: true } : {})
      },
      () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        chrome.runtime.lastError;
      }
    );
  } catch {
    // context invalidated, ignore
  }
}

/**
 * Check if the current site is a phishing site, and if so ask the background
 * to show the warning page in this tab, unless `showWarning` is false.
 * `pageHeld` says that the page is held, stopped before any of its own script
 * ran.
 */
export async function checkPhishing(showWarning = true, pageHeld = false): Promise<PhishingVerdict> {
  if (!isExtensionContextValid()) {
    return 'unknown';
  }
  const hostname = window.location.hostname;
  // A page without a hostname, such as a file: URL, cannot match the denylist.
  if (!hostname) {
    return 'clear';
  }
  try {
    const response = await new Promise<{ isPhishing?: unknown; isDenylisted?: unknown } | undefined>((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'CHECK_PHISHING',
          hostname,
          source: 'content_script'
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve(undefined);
            return;
          }
          resolve(response);
        }
      );
    });

    if (response?.isPhishing === true) {
      if (showWarning) {
        // The next load of this page is held again.
        forgetRelease();
        requestWarningPage(hostname, pageHeld);
      }
      return 'phishing';
    }
    if (response?.isPhishing === false && response.isDenylisted === true) {
      return 'proceeded';
    }
    if (response?.isPhishing === false && response.isDenylisted === false) {
      return 'clear';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Initialize phishing detection on page load. With `showWarning` false it
 * only reports the verdict; `pageHeld` is as for `checkPhishing`.
 */
export async function initializePhishingDetection(showWarning = true, pageHeld = false): Promise<PhishingVerdict> {
  const verdict = await checkPhishing(showWarning, pageHeld);
  // Retry once: a message sent while the service worker starts can be lost.
  return verdict === 'unknown' && isExtensionContextValid() ? checkPhishing(showWarning, pageHeld) : verdict;
}

/**
 * Setup phishing detection event listeners
 */
export function setupPhishingListeners(): void {
  let checkTimeout: NodeJS.Timeout | null = null;

  // Page navigation listener with debounce
  window.addEventListener('popstate', () => {
    if (checkTimeout) {
      clearTimeout(checkTimeout);
    }
    checkTimeout = setTimeout(checkPhishing, 100);
  });

  // Page visibility change listener
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkPhishing();
    }
  });
}
