/**
 * Extension implementation of the wallet's loopback-permission boundary.
 *
 * This is the only place that talks to `chrome.permissions` for the optional
 * local-regtest origin. Shared wallet packages receive the adapter through
 * `walletController.initRegtestAccess()` and never import Chrome globals.
 * Every method targets the exact reviewed origin; nothing here accepts a
 * caller-supplied host. There is deliberately no remove(): Chrome rejects
 * `permissions.remove()` for this origin because the `<all_urls>` content
 * script makes it a required scriptable host, so revocation happens from
 * Chrome's extension settings and arrives here through onRemoved.
 */
import type { RegtestAccessAdapter } from '@qbit/wallet-background';
import { QBIT_REGTEST_HOST_PERMISSION, QBIT_REGTEST_ORIGIN } from '@qbit/wallet-shared';

const PERMISSIONS: chrome.permissions.Permissions = Object.freeze({
  origins: [QBIT_REGTEST_HOST_PERMISSION]
}) as chrome.permissions.Permissions;

/** Forms Chrome may report for the reviewed origin in an onRemoved payload. */
const REMOVAL_MATCHES: ReadonlySet<string> = new Set([
  QBIT_REGTEST_HOST_PERMISSION,
  QBIT_REGTEST_ORIGIN,
  `${QBIT_REGTEST_ORIGIN}/`
]);

function callbackToPromise<T>(invoke: (callback: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      invoke((value) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'chrome.permissions call failed'));
          return;
        }
        resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * True when the running manifest lists the loopback origin as an optional
 * permission (store flavor). The E2E flavor promotes it to a required
 * permission, and MV2 builds carry it under their broad host access; neither
 * needs the in-app acknowledgement flow.
 */
export function isRegtestPermissionOptional(): boolean {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    optional_host_permissions?: string[];
  };
  const required = new Set<string>([
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
    ...(Array.isArray(manifest.permissions)
      ? manifest.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [])
  ]);
  if (required.has(QBIT_REGTEST_HOST_PERMISSION) || required.has('<all_urls>')) {
    return false;
  }
  const optional = [
    ...(Array.isArray(manifest.optional_host_permissions) ? manifest.optional_host_permissions : []),
    ...(Array.isArray(manifest.optional_permissions)
      ? manifest.optional_permissions.filter((entry): entry is string => typeof entry === 'string')
      : [])
  ];
  return optional.includes(QBIT_REGTEST_HOST_PERMISSION);
}

/**
 * Fallback used when the real adapter could not be wired. Every answer keeps
 * the capability locked, so a failure while setting the gate up cannot leave
 * `assertAvailable()` adapter-less — which would let regtest through
 * unchecked for the rest of the session. Fail closed, not open.
 */
export function createLockedRegtestAccessAdapter(): RegtestAccessAdapter {
  return {
    isOptionalPermission: () => true,
    containsPermission: () => Promise.resolve(false),
    onPermissionRemoved: () => undefined
  };
}

export function createRegtestAccessAdapter(): RegtestAccessAdapter {
  return {
    isOptionalPermission: isRegtestPermissionOptional,
    containsPermission: () =>
      callbackToPromise<boolean>((callback) => chrome.permissions.contains(PERMISSIONS, callback)).then(
        (granted) => granted === true
      ),
    onPermissionRemoved: (listener) => {
      chrome.permissions.onRemoved.addListener((removed) => {
        // The payload is only a hint; the service re-reads contains(). Match
        // the reviewed origin exactly rather than any loopback address, so
        // revoking an unrelated local service (127.0.0.1:8080) does not churn
        // the regtest capability. An empty payload still triggers a re-check.
        const origins = Array.isArray(removed?.origins) ? removed.origins : [];
        if (origins.length === 0 || origins.some((origin) => REMOVAL_MATCHES.has(origin))) {
          listener();
        }
      });
    }
  };
}
