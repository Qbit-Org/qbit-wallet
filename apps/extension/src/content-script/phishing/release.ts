/**
 * Release record module
 * Remembers, in the page's own sessionStorage, that the background let a
 * held page's host through in this tab
 */

// A page that has not been let through never runs script to write it, and
// one that writes it anyway only skips the hold: its check still sends it to
// the warning page.
const RELEASE_KEY = 'qbit-wallet:phishing-released';

/** Whether the background let the host through earlier in this tab. */
export function isReleased(hostname: string): boolean {
  try {
    return window.sessionStorage.getItem(RELEASE_KEY) === hostname;
  } catch {
    return false;
  }
}

/** Records a release, and whether it reads back, as the reload needs it to. */
export function recordRelease(hostname: string): boolean {
  try {
    window.sessionStorage.setItem(RELEASE_KEY, hostname);
    return window.sessionStorage.getItem(RELEASE_KEY) === hostname;
  } catch {
    return false;
  }
}

/**
 * Forgets that the background let the page's host through, once a check sends
 * the page to the warning page, for example because the Proceed of an
 * earlier browser session has ended.
 */
export function forgetRelease(): void {
  try {
    window.sessionStorage.removeItem(RELEASE_KEY);
  } catch {
    // Storage is unavailable, so nothing was recorded.
  }
}
