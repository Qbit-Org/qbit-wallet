import log from 'loglevel';
import React, { useEffect, useState } from 'react';

import {
  DEFAULT_THEME_MODE,
  THEME_MODES,
  THEME_MODE_STORAGE_KEY,
  ThemeMode
} from '@qbit/wallet-shared';
import { settingsActions, useAppDispatch, useThemeMode, useWallet } from '@qbit/wallet-state';

function resolveTheme(themeMode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  if (themeMode === 'system') {
    return prefersDark ? 'dark' : 'light';
  }
  return themeMode;
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  // Drop the hardcoded light background the HTML templates (and theme-init.js)
  // put on <body>; from here on the stylesheet's var(--qbit-canvas) rules.
  document.body.style.backgroundColor = '';
}

// localStorage can be denied outright by privacy settings or enterprise
// policy (theme-init.js guards the same access); the theme must still work
// from the background preference alone, only the pre-paint hint is lost.
function readCachedThemeMode(): ThemeMode | null {
  try {
    const cached = localStorage.getItem(THEME_MODE_STORAGE_KEY) as ThemeMode | null;
    return cached && THEME_MODES.includes(cached) ? cached : null;
  } catch {
    return null;
  }
}

function cacheThemeMode(themeMode: ThemeMode) {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
  } catch {
    // Cache unavailable; nothing to do.
  }
}

/**
 * Applies the persisted theme mode (light/dark/system) to the document.
 *
 * The background preference service is the source of truth; localStorage keeps
 * a cache that build/_raw/theme-init.js reads to set data-theme before first
 * paint, so popup opens don't flash the wrong theme.
 */
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const themeMode = useThemeMode();
  const wallet = useWallet();
  const dispatch = useAppDispatch();
  // Gates the apply effect until the localStorage cache has been dispatched.
  // Without it, the first apply runs with redux's default 'system', repainting
  // over theme-init's pre-paint theme and clobbering the cache for a frame
  // whenever the persisted mode differs from the OS preference.
  const [hydrated, setHydrated] = useState(false);

  // Hydrate redux from the localStorage cache immediately, then reconcile with
  // the background preference (the source of truth).
  useEffect(() => {
    const cached = readCachedThemeMode();
    if (cached && cached !== DEFAULT_THEME_MODE) {
      dispatch(settingsActions.updateSettings({ themeMode: cached }));
    }
    setHydrated(true);
    wallet
      .getThemeMode()
      .then((stored) => {
        if (stored && THEME_MODES.includes(stored)) {
          dispatch(settingsActions.updateSettings({ themeMode: stored }));
        }
      })
      .catch((e) => {
        log.error('Failed to load theme mode preference:', e);
      });
  }, [wallet, dispatch]);

  // Follow theme changes made from other open extension documents (popup,
  // side panel, notification). The initiating document mirrors the mode to
  // localStorage below, which fires the `storage` event in every other
  // same-origin document.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const next = event.newValue as ThemeMode | null;
      if (event.key === THEME_MODE_STORAGE_KEY && next && THEME_MODES.includes(next)) {
        dispatch(settingsActions.updateSettings({ themeMode: next }));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [dispatch]);

  // Apply the active mode and cache it; follow OS changes while in system mode.
  // theme-init.js already painted the cached theme, so skipping until
  // hydration keeps the pre-paint theme untouched.
  useEffect(() => {
    if (!hydrated) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(resolveTheme(themeMode, media.matches));
    cacheThemeMode(themeMode);

    if (themeMode !== 'system') return;
    const onChange = (event: MediaQueryListEvent) => {
      applyTheme(resolveTheme('system', event.matches));
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [themeMode, hydrated]);

  return <>{children}</>;
};
