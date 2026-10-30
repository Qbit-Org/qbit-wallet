import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreferenceService } from '@qbit/preference-service';
import { BaseProxyStorageAdapter } from '@qbit/wallet-storage';

const browserStorage = vi.hoisted(() => ({
  disk: {} as Record<string, unknown>,
  get: vi.fn(),
  set: vi.fn()
}));

vi.mock('@/background/webapi/browser', () => ({
  browserStorageLocalGet: browserStorage.get,
  browserStorageLocalSet: browserStorage.set
}));

// Wallet data under other keys, which loading the settings must leave alone.
const WALLET_DATA = {
  keyringState: { booted: 'encrypted-check', vault: 'encrypted-vault', boostValue: 'boost' },
  contactBook: {}
};

// A preference record as 1.0.5 saves it: its template, with settings changed.
const PREFERENCE_1_0_5 = {
  currentKeyringIndex: 0,
  currentAccount: { type: 'HD Key Tree', pubkey: '02aa', address: 'q-address', key: 'q-address', flag: 0, index: 0 },
  editingKeyringIndex: 0,
  externalLinkAck: true,
  balanceMap: {},
  historyMap: {},
  locale: 'fr',
  watchAddressPreference: {},
  walletSavedList: [],
  alianNames: {},
  initAlianNames: true,
  currentVersion: '0',
  firstOpen: true,
  currency: 'EUR',
  chainType: 'QBIT_MAINNET',
  keyringAlianNames: { keyring_0: 'Savings' },
  accountAlianNames: {},
  uiCachedData: {},
  skippedVersion: '',
  showSafeNotice: false,
  addressFlags: {},
  enableSignData: true,
  autoLockTimeId: 5,
  openInSidePanel: false,
  developerMode: false,
  themeMode: 'dark',
  rateUsStatus: { hasRated: true, ratePromptDismissedAt: 0, hasShownSecondPrompt: false },
  acceptLowFeeMode: false,
  enableRBF: false
};

// Load the settings as the background does at a service-worker start: over a
// fresh copy of its storage module.
const initPreferences = async () => {
  vi.resetModules();
  const storage = (await import('@/background/utils/storage')).default;
  const adapter = new (class extends BaseProxyStorageAdapter {
    get(key: string) {
      return storage.get(key);
    }
    set(key: string, value: unknown) {
      return storage.set(key, value);
    }
  })();
  const service = new PreferenceService();
  const init = service.init({ storage: adapter, logger: { debug: vi.fn(), error: vi.fn() } });
  return { service, init };
};

describe('loading the settings at start-up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    browserStorage.disk = {};
    browserStorage.get.mockImplementation(async () => structuredClone(browserStorage.disk));
    browserStorage.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(browserStorage.disk, structuredClone(items));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['on a first install', {}],
    ['when only the settings are missing', WALLET_DATA]
  ])('saves the template and starts %s although its first write fails', async (_case, stored) => {
    browserStorage.disk = structuredClone(stored);
    browserStorage.set.mockRejectedValueOnce(new Error('IO error'));

    const { service, init } = await initPreferences();
    const started = expect(init).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    await started;

    expect(browserStorage.set).toHaveBeenCalledTimes(2);
    expect(browserStorage.disk).toMatchObject(stored);
    expect(browserStorage.disk.preference).toMatchObject({ locale: 'en', enableSignData: false, enableRBF: true });
    expect(service.getEnableSignData()).toBe(false);

    // The next start loads the saved settings and writes nothing.
    browserStorage.set.mockClear();
    const restarted = await initPreferences();
    await restarted.init;
    expect(browserStorage.set).not.toHaveBeenCalled();
  });

  it('writes the same template again when a write that failed had landed', async () => {
    browserStorage.set.mockImplementationOnce(async (items: Record<string, unknown>) => {
      Object.assign(browserStorage.disk, structuredClone(items));
      throw new Error('IO error');
    });

    const { init } = await initPreferences();
    const started = expect(init).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    await started;

    const [[landed], [retried]] = browserStorage.set.mock.calls;
    expect(retried).toEqual(landed);
    expect(browserStorage.disk).toEqual(landed);
  });

  it('stops after three attempts when the template cannot be saved', async () => {
    browserStorage.disk = structuredClone(WALLET_DATA);
    const writeError = new Error('IO error');
    browserStorage.set.mockRejectedValue(writeError);

    const { init } = await initPreferences();
    const failed = expect(init).rejects.toBe(writeError);
    await vi.advanceTimersByTimeAsync(300);
    await failed;

    expect(browserStorage.set).toHaveBeenCalledTimes(3);
    expect(browserStorage.disk).toEqual(WALLET_DATA);
  });

  it('loads the settings 1.0.5 saved without writing the template over them', async () => {
    browserStorage.disk = { ...structuredClone(WALLET_DATA), preference: structuredClone(PREFERENCE_1_0_5) };

    const { service, init } = await initPreferences();
    await init;

    expect(browserStorage.set).not.toHaveBeenCalled();
    expect(browserStorage.disk.preference).toEqual(PREFERENCE_1_0_5);
    expect(service.getLocale()).toBe('fr');
    expect(service.getCurrency()).toBe('EUR');
    expect(service.getEnableSignData()).toBe(true);
    expect(service.getAutoLockTimeId()).toBe(5);
    expect(service.getEnableRBF()).toBe(false);
    expect(service.getKeyringAlianName('keyring_0')).toBe('Savings');
    expect(service.getCurrentAccount()).toEqual(PREFERENCE_1_0_5.currentAccount);
  });

  it('stops and writes nothing when the stored settings cannot be read', async () => {
    browserStorage.disk = { ...structuredClone(WALLET_DATA), preference: structuredClone(PREFERENCE_1_0_5) };
    browserStorage.get.mockRejectedValue(new Error('IO error'));

    const { init } = await initPreferences();
    const failed = expect(init).rejects.toThrow('Failed to load stored data for preference');
    await vi.advanceTimersByTimeAsync(300);
    await failed;

    expect(browserStorage.get).toHaveBeenCalledTimes(3);
    expect(browserStorage.set).not.toHaveBeenCalled();
    expect(browserStorage.disk.preference).toEqual(PREFERENCE_1_0_5);
  });
});
