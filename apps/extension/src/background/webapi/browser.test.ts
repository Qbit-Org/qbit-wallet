import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageGet = vi.fn();
const storageSet = vi.fn();

// Chrome has no `browser` global, so the module resolves `chrome`, whose
// storage calls return a promise that rejects when the operation fails.
beforeEach(() => {
  vi.resetModules();
  storageGet.mockReset();
  storageSet.mockReset();
  vi.stubGlobal('browser', undefined);
  vi.stubGlobal('chrome', {
    storage: { local: { get: storageGet, set: storageSet } }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserStorageLocalSet', () => {
  it('resolves when the storage write succeeds', async () => {
    storageSet.mockResolvedValueOnce(undefined);
    const { browserStorageLocalSet } = await import('./browser');
    const value = { keyringState: 'encrypted' };

    await expect(browserStorageLocalSet(value)).resolves.toBeUndefined();
    expect(storageSet).toHaveBeenCalledWith(value);
  });

  it('rejects with the browser error when the storage write fails', async () => {
    const quotaError = new Error('QUOTA_BYTES quota exceeded');
    storageSet.mockRejectedValueOnce(quotaError);
    const { browserStorageLocalSet } = await import('./browser');

    await expect(browserStorageLocalSet({ keyringState: 'encrypted' })).rejects.toBe(quotaError);
  });
});

describe('browserStorageLocalGet', () => {
  it('resolves with the stored items', async () => {
    const items = { keyringState: 'encrypted' };
    storageGet.mockResolvedValueOnce(items);
    const { browserStorageLocalGet } = await import('./browser');

    await expect(browserStorageLocalGet(null)).resolves.toBe(items);
    expect(storageGet).toHaveBeenCalledWith(null);
  });

  it('rejects with the browser error when the storage read fails', async () => {
    const readError = new Error('Failed to read storage');
    storageGet.mockRejectedValueOnce(readError);
    const { browserStorageLocalGet } = await import('./browser');

    await expect(browserStorageLocalGet(null)).rejects.toBe(readError);
  });
});
