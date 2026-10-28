import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserStorage = vi.hoisted(() => ({
  disk: {} as Record<string, unknown>,
  get: vi.fn(),
  set: vi.fn()
}));

vi.mock('@/background/webapi/browser', () => ({
  browserStorageLocalGet: browserStorage.get,
  browserStorageLocalSet: browserStorage.set
}));

import { PreferenceService } from '@qbit/preference-service';
import { BaseProxyStorageAdapter } from '@qbit/wallet-storage';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// The background's adapter: preference saves go through its storage module.
const createAdapter = async () => {
  const storage = (await import('@/background/utils/storage')).default;
  return new (class extends BaseProxyStorageAdapter {
    get(key: string) {
      return storage.get(key);
    }
    set(key: string, value: unknown) {
      return storage.set(key, value);
    }
  })();
};

const load = async (adapter: BaseProxyStorageAdapter) => {
  const service = new PreferenceService();
  await service.init({ storage: adapter, logger: { debug: vi.fn(), error: vi.fn() } });
  return service;
};

describe('preference restore and saves already in flight', () => {
  beforeEach(() => {
    vi.resetModules();
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

  it('saves the restored value after a debounced save that captured the failed one', async () => {
    const adapter = await createAdapter();
    const service = await load(adapter);
    await vi.advanceTimersByTimeAsync(1000);

    // The setting's save is slow and then fails; the next save is slow too.
    const settingWrite = deferred();
    const otherWrite = deferred();
    const writeError = new Error('write failed');
    const write = browserStorage.set.getMockImplementation()!;
    browserStorage.set
      .mockImplementationOnce(async () => {
        await settingWrite.promise;
        throw writeError;
      })
      .mockImplementationOnce(async (items: Record<string, unknown>) => {
        await otherWrite.promise;
        await write(items);
      });
    const setting = service.setEnableSignData(true);
    const settingResult = expect(setting).rejects.toBe(writeError);
    await vi.waitFor(() => expect(browserStorage.set).toHaveBeenCalledTimes(3));

    // Another preference changes, and its debounced save takes the store with
    // sign-data on while the setting's save is still in flight.
    service.setShowSafeNotice(false);
    await vi.advanceTimersByTimeAsync(1000);
    // The setting's save fails and the restored value's save is requested
    // while the debounced save is still in flight. The storage module writes
    // in call order, so the restored value lands last.
    settingWrite.resolve();
    await vi.advanceTimersByTimeAsync(0);
    otherWrite.resolve();
    await settingResult;
    await vi.advanceTimersByTimeAsync(0);

    // The debounced save landed first, then the restored value.
    expect(browserStorage.set.mock.calls.slice(2).map(([items]) => (items as any).preference.enableSignData)).toEqual([
      true,
      true,
      false
    ]);
    expect(service.getEnableSignData()).toBe(false);
    expect((browserStorage.disk.preference as any).enableSignData).toBe(false);
    expect((await load(adapter)).getEnableSignData()).toBe(false);
  });
});
