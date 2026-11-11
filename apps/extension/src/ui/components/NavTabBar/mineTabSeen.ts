// Whether the user has opened the Mine tab, which retires its "NEW" badge.
// Kept in localStorage so it survives popup/side-panel teardown (the
// EcosystemWarningModal pattern).
export const MINE_TAB_SEEN_STORAGE_KEY = 'mine_tab_seen';

// localStorage can be denied by privacy settings or enterprise policy; treat
// that as not-yet-seen so the badge still shows.
export function readMineTabSeen(): boolean {
  try {
    return localStorage.getItem(MINE_TAB_SEEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markMineTabSeen(): void {
  try {
    localStorage.setItem(MINE_TAB_SEEN_STORAGE_KEY, 'true');
  } catch {
    // Cache unavailable; the badge shows again on the next popup open.
  }
}
