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

function requestWarningPage(hostname: string): void {
  if (!isExtensionContextValid()) return;
  try {
    chrome.runtime.sendMessage(
      {
        type: 'REDIRECT_TO_PHISHING_PAGE',
        hostname,
        // Proceed returns to this exact URL instead of the bare hostname.
        url: window.location.href
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
 * to show the warning page in this tab
 */
export async function checkPhishing(): Promise<PhishingVerdict> {
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
      // The next load of this page is held again.
      forgetRelease();
      requestWarningPage(hostname);
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
 * Initialize phishing detection on page load
 */
export async function initializePhishingDetection(): Promise<PhishingVerdict> {
  const verdict = await checkPhishing();
  // Retry once: a message sent while the service worker starts can be lost.
  return verdict === 'unknown' && isExtensionContextValid() ? checkPhishing() : verdict;
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
