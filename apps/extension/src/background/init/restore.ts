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

class ExtensionStorageAdapter extends BaseProxyStorageAdapter {
  // The errors of reads that failed while start-up ran, kept only so start-up
  // can say why it stopped. Every caller still gets the error storage raised.
  private startupReadErrors: Set<unknown> | undefined = new Set();

  constructor(private storage) {
    super();
  }

  async get(key: string): Promise<any> {
    try {
      return await this.storage.get(key);
    } catch (error) {
      this.startupReadErrors?.add(error);
      throw error;
    }
  }

  /**
   * Whether `error` is, or has among its causes, a read that failed during
   * start-up. Services may wrap the read error (wallet-storage's loadStored
   * does), so the causes count too.
   */
  isStartupReadError(error: unknown): boolean {
    const seen = new Set<unknown>();
    for (
      let current = error;
      current !== null && current !== undefined && !seen.has(current);
      current = (current as { cause?: unknown }).cause
    ) {
      if (this.startupReadErrors?.has(current)) return true;
      seen.add(current);
    }
    return false;
  }

  /** Start-up is over: reads that fail from now on are not recorded. */
  endStartup(): void {
    this.startupReadErrors = undefined;
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
  const proxyStorage = new ExtensionStorageAdapter(storage);
  // Each service starts under its own handler, which names it in the log. A
  // required service that fails stops start-up. An optional one is logged and
  // the rest of the background starts without it, unless it could not read the
  // stored settings: that still stops start-up, so the pages can say why.
  const startService = async (name: string, init: () => unknown, { required = true } = {}) => {
    try {
      await init();
    } catch (err) {
      if (required || proxyStorage.isStartupReadError(err)) {
        logger.error(`[Background] ${name} failed to start`, err);
        throw err;
      }
      logger.error(`[Background] ${name} failed to start; starting the rest without it`, err);
    }
  };

  try {
    await startService('i18n', () => i18nService.init({ storage: proxyStorage }));
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

    await startService('keyring', () =>
      keyringService.init({
        storage: proxyStorage,
        logger: logger,
        encryptor: encryptor,
        t: t,
        eventBus: bgEventBus
      })
    );

    await startService('preference', () =>
      preferenceService.init({
        storage: proxyStorage,
        logger: logger,
        t: t,
        eventBus: bgEventBus as any
      })
    );

    await startService('biometric unlock', () =>
      biometricUnlockService.init({
        storage: proxyStorage,
        logger: logger
      })
    );

    await startService('send guard', () => qbitSendGuardService.init());

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
    await startService('wallet API', () =>
      walletApiService.init({
        storage: proxyStorage,
        logger: logger,
        endpoint,
        httpClient: httpClient
      })
    );

    // Without it no website has a grant until the permissions load again, which
    // fails closed, so the rest of the background still starts.
    await startService(
      'permission',
      () =>
        permissionService.init({
          storage: proxyStorage,
          logger: logger,
          autoSync: true
        }),
      { required: false }
    );

    await startService('contact book', () =>
      contactBookService.init({
        storage: proxyStorage,
        logger: logger
      })
    );

    await startService('notification', () =>
      notificationService.init({
        storage: proxyStorage,
        logger: logger,
        api: walletApiService
      })
    );

    const adapter = new ExtensionAdapter();
    await startService('phishing detection', () =>
      phishingDetectService.init({
        adapter,
        logger: logger,
        t: t
      })
    );
    // Initialize phishing service early to ensure protection is active

    appStateRestored = true;

    walletController.setBackgroundInited(true);
  } catch (err) {
    console.error('[Background] Initialization failed', err);
    // In memory only: reporting the failure writes nothing to storage.
    walletController.setBackgroundStartupFailed(
      proxyStorage.isStartupReadError(err) ? 'stored-settings-unreadable' : 'unknown'
    );
  } finally {
    proxyStorage.endStartup();
  }
}

export function isAppStateRestored(): boolean {
  return appStateRestored;
}
