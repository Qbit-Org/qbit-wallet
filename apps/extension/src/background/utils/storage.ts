import { browserStorageLocalGet, browserStorageLocalSet } from '../webapi/browser';

// A copy of chrome.storage.local, read once. Values are cloned on the way in
// and out, so a caller mutating what it read or wrote cannot change the cache,
// and the cache changes only after a write succeeds.
let cacheMap: Map<string, unknown> | undefined;
let loading: Promise<Map<string, unknown>> | undefined;
// Writes run one at a time in call order, so an older write never lands after
// a newer one, and a read waits for the writes requested before it.
let writeQueue: Promise<void> = Promise.resolve();

const load = (): Promise<Map<string, unknown>> => {
  if (cacheMap) {
    return Promise.resolve(cacheMap);
  }

  if (!loading) {
    loading = browserStorageLocalGet(null)
      .then((result) => {
        if (!result || typeof result !== 'object') {
          throw new Error('Failed to read browser storage');
        }
        cacheMap = new Map(Object.entries(result));
        return cacheMap;
      })
      .finally(() => {
        loading = undefined;
      });
  }
  return loading;
};

const get = async (prop?: string) => {
  await writeQueue;
  const cache = await load();
  return structuredClone(prop ? cache.get(prop) : Object.fromEntries(cache));
};

const set = async (prop: string, value: unknown): Promise<void> => {
  const snapshot = structuredClone(value);
  const write = writeQueue.then(async () => {
    if (loading) {
      // A read still in flight would otherwise publish data from before this
      // write. The write does not need the read to succeed.
      await loading.catch(() => undefined);
    }
    await browserStorageLocalSet({ [prop]: snapshot });
    cacheMap?.set(prop, snapshot);
  });
  writeQueue = write.catch(() => undefined);
  return write;
};

const byteInUse = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    if (chrome) {
      chrome.storage.local.getBytesInUse((value) => {
        resolve(value);
      });
    } else {
      reject('ByteInUse only works in Chrome');
    }
  });
};

export default {
  get,
  set,
  byteInUse
};
