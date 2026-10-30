/**
 * Mobile app entry. Runs the extension's background and UI in one WebView:
 *
 * 1. load persisted storage and publish the in-page `chrome` stand-in;
 * 2. boot the background (it registers its port listener);
 * 3. boot the UI, which connects to the background over an in-memory port.
 *
 * Steps 2 and 3 are dynamic imports so that nothing from the wallet runs
 * before step 1 has finished.
 */
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

import { installChromeShim, MOBILE_PAGE } from './chrome-shim/install';
import type { KeyValueBackend } from './chrome-shim/storage';

const preferencesBackend: KeyValueBackend = {
  keys: async () => (await Preferences.keys()).keys,
  get: async (key) => (await Preferences.get({ key })).value,
  set: (key, value) => Preferences.set({ key, value }),
  remove: (key) => Preferences.remove({ key })
};

/**
 * Biometric unlock in the extension is a WebAuthn ceremony bound to the
 * extension origin. It cannot work from the app origin, so hide WebAuthn and
 * let the UI fall back to password unlock. Native Keychain unlock is a
 * follow-up.
 */
function hideWebAuthn() {
  try {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
  } catch {
    // Leave it in place; enrollment would then fail with a visible error.
  }
}

function mobilePlatform(): 'ios' | 'android' | 'unknown' {
  const platform = Capacitor.getPlatform();
  return platform === 'ios' || platform === 'android' ? platform : 'unknown';
}

async function boot() {
  hideWebAuthn();

  await installChromeShim({
    origin: location.origin,
    version: process.env.release || '0.0.0',
    os: mobilePlatform() === 'unknown' ? 'web' : mobilePlatform(),
    backend: preferencesBackend,
    openExternalUrl: (url) => Browser.open({ url }),
    navigateToHash: (hash) => {
      location.hash = hash;
    }
  });

  await import('@/background/index');

  const { PlatformEnv } = await import('@qbit/wallet-shared');
  PlatformEnv.PLATFORM = mobilePlatform();

  await import('@/ui/index');
}

if (location.pathname !== `/${MOBILE_PAGE}`) {
  // The UI picks its layout from the page path; the side-panel layout is the
  // full-height, narrow one that fits a phone.
  location.replace(`/${MOBILE_PAGE}${location.hash}`);
} else {
  boot().catch((error) => {
    console.error('[mobile] boot failed', error);
    const root = document.getElementById('root');
    if (root) root.textContent = 'Qbit Wallet failed to start. Please restart the app.';
  });
}
