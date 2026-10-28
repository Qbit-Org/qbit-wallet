import { EventEmitter } from 'events';
import logger from 'loglevel';

// Static (not dynamic) imports: the MV3 service worker cannot load webpack
// async chunks (the JSONP loader references `document`), so these must be
// inlined into background.js rather than split into a lazily-fetched chunk.
import { init as initPqcClient } from '@qbit-oss/pqc';
import createPqcModule from '@qbit-oss/pqc/wasm/pqc.mjs';

// init/restore.ts
import { i18nService } from '@/shared/utils/i18n';
import { ExtensionAdapter } from '@qbit/phishing-detect';
import {
  bgEventBus,
  biometricUnlockService,
  contactBookService,
  keyringService,
  notificationService,
  permissionService,
  phishingDetectService,
  preferenceService,
  qbitSendGuardService,
  walletApiService,
  walletController
} from '@qbit/wallet-background';
import { bgI18n, CHAINS_MAP, normalizeChainType, t } from '@qbit/wallet-shared';
import { BaseProxyStorageAdapter } from '@qbit/wallet-storage';
import { ChainType } from '@qbit/wallet-types';

import { createLockedRegtestAccessAdapter, createRegtestAccessAdapter } from '../regtest/regtestAccessAdapter';
import { encryptor } from '../utils/encryptor';
import { HttpClient } from '../utils/http-client/httpClient';
import storage from '../utils/storage';

export const AppInitEvent = new EventEmitter();

/**
 * The browser's storage could not be read, so the stored settings are unknown,
 * not absent. Start-up stops rather than writing defaults over them.
 */
export class StoredSettingsReadError extends Error {
  constructor(cause: unknown) {
    super('Stored settings could not be read');
    this.name = 'StoredSettingsReadError';
    (this as { cause?: unknown }).cause = cause;
  }
}

class ExtensionStorageAdapter extends BaseProxyStorageAdapter {
  constructor(private storage) {
    super();
  }

  async get(key: string): Promise<any> {
    try {
      return await this.storage.get(key);
    } catch (error) {
      throw new StoredSettingsReadError(error);
    }
  }

  async set(key: string, value: any): Promise<void> {
    await this.storage.set(key, value);
  }
}

let appStateRestored = false;

async function initPqcRuntime() {
  await initPqcClient({
    createModule: createPqcModule,
    locateFile: (wasmPath: string) => {
      const localPath = `wasm/${wasmPath}`;
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(localPath);
      }
      return localPath;
    }
  });
}

export async function restoreAppState() {
  try {
    const proxyStorage = new ExtensionStorageAdapter(storage);

    await i18nService.init({ storage: proxyStorage });
    bgI18n.t = i18nService.translate.bind(i18nService);
    bgI18n.changeLanguage = async (locale: string) => {
      await i18nService.changeLanguage(locale);
    };

    // PQC init must never gate the whole wallet: if it fails, degrade to
    // "Qbit P2MR features unavailable" rather than bricking every account.
    try {
      await initPqcRuntime();
    } catch (pqcInitError) {
      logger.error('[qbit] PQC runtime init failed; P2MR features disabled', pqcInitError);
    }

    await keyringService.init({
      storage: proxyStorage,
      logger: logger,
      encryptor: encryptor,
      t: t,
      eventBus: bgEventBus
    });

    await preferenceService.init({
      storage: proxyStorage,
      logger: logger,
      t: t,
      eventBus: bgEventBus as any
    });

    await biometricUnlockService.init({
      storage: proxyStorage,
      logger: logger
    });

    qbitSendGuardService.init();

    // Local regtest is gated by a background capability (optional loopback
    // host permission + acknowledgement + verified service). Resolve it before
    // any API client is bound to an endpoint: a persisted regtest selection
    // that no longer passes falls back to mainnet here, fail-closed.
    let chainType: ChainType;
    let regtestGateWired = false;
    try {
      walletController.initRegtestAccess({ adapter: createRegtestAccessAdapter() });
      regtestGateWired = true;
      chainType = normalizeChainType(await walletController.prepareStartupChainType());
    } catch (regtestGateError) {
      logger.error('[Background] Regtest capability check failed at startup', {
        name: (regtestGateError as { name?: unknown })?.name
      });
      if (!regtestGateWired) {
        // Wiring the gate is what installs the capability's adapter, and
        // without one assertAvailable() has nothing to check and lets regtest
        // through for the rest of the session. Install a permanently locked
        // adapter so the failure closes the gate instead of opening it.
        walletController.initRegtestAccess({ adapter: createLockedRegtestAccessAdapter() });
      }
      // Fail closed for regtest only. A failure in the gate itself says
      // nothing about a persisted public network, so testnet/mainnet
      // selections are left exactly as the user left them.
      const persisted = normalizeChainType(preferenceService.getChainType());
      chainType = persisted === ChainType.QBIT_REGTEST ? ChainType.QBIT_MAINNET : persisted;
      if (chainType !== persisted) {
        preferenceService.setChainType(chainType);
      }
    }
    const endpoint = CHAINS_MAP[chainType].endpoints[0];
    const httpClient = new HttpClient();
    await walletApiService.init({
      storage: proxyStorage,
      logger: logger,
      endpoint,
      httpClient: httpClient
    });

    await permissionService.init({
      storage: proxyStorage,
      logger: logger,
      autoSync: true
    });

    await contactBookService.init({
      storage: proxyStorage,
      logger: logger
    });

    await notificationService.init({
      storage: proxyStorage,
      logger: logger,
      api: walletApiService
    });

    const adapter = new ExtensionAdapter();
    await phishingDetectService.init({
      adapter,
      logger: logger,
      t: t
    });
    // Initialize phishing service early to ensure protection is active

    appStateRestored = true;

    walletController.setBackgroundInited(true);
  } catch (err) {
    console.error('[Background] Initialization failed', err);
    // In memory only: a failed start-up writes nothing to storage.
    walletController.setBackgroundStartupFailed(startupFailureReason(err));
  }
}

// Services may wrap the read error (wallet-storage's loadStored does), so look
// through the causes as well.
function startupFailureReason(error: unknown): 'stored-settings-unreadable' | 'unknown' {
  const seen = new Set<unknown>();
  for (
    let current: unknown = error;
    current instanceof Error && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    if (current instanceof StoredSettingsReadError) return 'stored-settings-unreadable';
    seen.add(current);
  }
  return 'unknown';
}

export function isAppStateRestored(): boolean {
  return appStateRestored;
}
