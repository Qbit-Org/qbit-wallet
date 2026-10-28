import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@qbit/wallet-shared', () => ({
  PlatformEnv: { MANIFEST_VERSION: 'mv2' }
}));

type StorageSetCallback = (result?: unknown) => void;

const runtime: { lastError?: { message?: string } } = {};
const storageSet = vi.fn();

describe('browserStorageLocalSet', () => {
  beforeEach(() => {
    vi.resetModules();
    storageSet.mockReset();
    delete runtime.lastError;
    vi.stubGlobal('browser', {
      runtime,
      storage: { local: { set: storageSet } }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves when an MV2 storage write succeeds', async () => {
    storageSet.mockImplementationOnce((_value: unknown, callback: StorageSetCallback) => {
      callback();
    });
    const { browserStorageLocalSet } = await import('./browser');
    const value = { keyringState: 'encrypted' };

    await expect(browserStorageLocalSet(value)).resolves.toBeUndefined();
    expect(storageSet).toHaveBeenCalledWith(value, expect.any(Function));
  });

  it('rejects when an MV2 storage write reports runtime.lastError', async () => {
    storageSet.mockImplementationOnce((_value: unknown, callback: StorageSetCallback) => {
      runtime.lastError = { message: 'Storage quota exceeded' };
      callback();
      delete runtime.lastError;
    });
    const { browserStorageLocalSet } = await import('./browser');

    await expect(browserStorageLocalSet({ keyringState: 'encrypted' })).rejects.toThrow('Storage quota exceeded');
  });
});
