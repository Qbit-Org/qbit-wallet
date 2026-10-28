import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserStorage = vi.hoisted(() => ({
  disk: {} as Record<string, unknown>,
  get: vi.fn(),
  set: vi.fn()
}));

vi.mock('../webapi/browser', () => ({
  browserStorageLocalGet: browserStorage.get,
  browserStorageLocalSet: browserStorage.set
}));

const loadStorage = async () => (await import('./storage')).default;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('background storage', () => {
  beforeEach(() => {
    vi.resetModules();
    browserStorage.disk = { preference: { locale: 'en' }, contactBook: {} };
    browserStorage.get.mockImplementation(async () => structuredClone(browserStorage.disk));
    browserStorage.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(browserStorage.disk, structuredClone(items));
    });
  });

  it('returns all data without a key, also once the cache is loaded', async () => {
    const storage = await loadStorage();

    expect(await storage.get()).toEqual(browserStorage.disk);
    expect(await storage.get()).toEqual(browserStorage.disk);
    expect(await storage.get('preference')).toEqual({ locale: 'en' });
    expect(browserStorage.get).toHaveBeenCalledTimes(1);
  });

  it('accepts a write before the first read', async () => {
    const storage = await loadStorage();

    await expect(storage.set('permission', { dumpCache: [] })).resolves.toBeUndefined();
    expect(browserStorage.disk.permission).toEqual({ dumpCache: [] });
    expect(await storage.get('permission')).toEqual({ dumpCache: [] });
  });

  it('does not let callers change the cache through objects they read or wrote', async () => {
    const storage = await loadStorage();
    const written = { dumpCache: [['https://a.example', { isConnected: true }]] };
    await storage.set('permission', written);

    written.dumpCache.push(['https://b.example', { isConnected: true }]);
    const read = (await storage.get('permission')) as typeof written;
    read.dumpCache.length = 0;

    expect(await storage.get('permission')).toEqual({
      dumpCache: [['https://a.example', { isConnected: true }]]
    });
  });

  it('leaves the cache unchanged and rejects when a write fails', async () => {
    const storage = await loadStorage();
    await storage.get();
    const writeError = new Error('QUOTA_BYTES quota exceeded');
    browserStorage.set.mockRejectedValueOnce(writeError);

    await expect(storage.set('permission', { dumpCache: [['https://a.example', {}]] })).rejects.toBe(writeError);
    expect(await storage.get('permission')).toBeUndefined();
  });

  it('keeps a write made while the first read is still in flight', async () => {
    const read = deferred<Record<string, unknown>>();
    browserStorage.get.mockImplementationOnce(() => read.promise);
    const storage = await loadStorage();

    const reading = storage.get('preference');
    const writing = storage.set('preference', { locale: 'fr' });
    read.resolve(structuredClone(browserStorage.disk));
    await Promise.all([reading, writing]);

    expect(browserStorage.disk.preference).toEqual({ locale: 'fr' });
    expect(await storage.get('preference')).toEqual({ locale: 'fr' });
  });

  it('lands writes in call order even when an earlier one is slower', async () => {
    const storage = await loadStorage();
    await storage.get();
    const slowWrite = deferred<void>();
    const write = browserStorage.set.getMockImplementation()!;
    browserStorage.set.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await slowWrite.promise;
      await write(items);
    });

    const older = storage.set('preference', { locale: 'fr' });
    const newer = storage.set('preference', { locale: 'ja' });
    slowWrite.resolve();
    await Promise.all([older, newer]);

    expect(browserStorage.disk.preference).toEqual({ locale: 'ja' });
    expect(await storage.get('preference')).toEqual({ locale: 'ja' });
  });

  it('reads back a write requested while the first read is in flight', async () => {
    const read = deferred<Record<string, unknown>>();
    browserStorage.get.mockImplementationOnce(() => read.promise);
    const storage = await loadStorage();

    const firstRead = storage.get('preference');
    void storage.set('preference', { locale: 'fr' });
    const readAfterWrite = storage.get('preference');
    read.resolve(structuredClone(browserStorage.disk));

    expect(await firstRead).toEqual({ locale: 'en' });
    expect(await readAfterWrite).toEqual({ locale: 'fr' });
  });

  it('still writes when a read in flight fails', async () => {
    const readError = new Error('storage unavailable');
    browserStorage.get.mockRejectedValueOnce(readError);
    const storage = await loadStorage();

    const reading = storage.get('preference');
    await storage.set('preference', { locale: 'fr' });

    await expect(reading).rejects.toBe(readError);
    expect(browserStorage.disk.preference).toEqual({ locale: 'fr' });
    expect(await storage.get('preference')).toEqual({ locale: 'fr' });
  });

  it('rejects a failed read and reads again on the next call', async () => {
    const storage = await loadStorage();
    const readError = new Error('storage unavailable');
    browserStorage.get.mockRejectedValueOnce(readError);

    await expect(storage.get('preference')).rejects.toBe(readError);
    expect(await storage.get('preference')).toEqual({ locale: 'en' });
    expect(browserStorage.get).toHaveBeenCalledTimes(2);
  });
});
