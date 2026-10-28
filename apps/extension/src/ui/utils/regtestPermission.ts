/**
 * Request the optional loopback host permission for local Qbit regtest.
 *
 * Chrome only honours `permissions.request()` inside a user gesture, so this
 * must be the first statement of the button's click handler with no awaited
 * work before it. The origin is fixed; callers cannot pass one in. The result
 * is a browser fact only: the background re-reads `permissions.contains()`
 * before anything is unlocked, so a forged `true` here grants nothing.
 */
import { QBIT_REGTEST_HOST_PERMISSION } from '@qbit/wallet-shared';

export const REGTEST_PERMISSION_REQUEST: chrome.permissions.Permissions = Object.freeze({
  origins: [QBIT_REGTEST_HOST_PERMISSION]
}) as chrome.permissions.Permissions;

export function requestRegtestHostPermission(): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    try {
      const permissions = (globalThis as { chrome?: typeof chrome }).chrome?.permissions;
      if (!permissions || typeof permissions.request !== 'function') {
        reject(new Error('chrome.permissions is unavailable'));
        return;
      }
      permissions.request(REGTEST_PERMISSION_REQUEST, (granted) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'permission request failed'));
          return;
        }
        resolve(granted === true);
      });
    } catch (error) {
      reject(error);
    }
  });
}
