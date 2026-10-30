/**
 * `chrome.storage.local` stand-in backed by durable native key/value storage.
 *
 * Every value is stored as its own JSON string, mirroring how Chrome
 * serializes `storage.local` values. The whole store is loaded into memory
 * once at boot so reads are synchronous-fast, and writes go through a single
 * queue: each write reaches the backend before the in-memory copy changes,
 * so a failed write leaves both the backend and later reads on the old value.
 */

export interface KeyValueBackend {
  keys(): Promise<string[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

import type { Settle } from './callbacks';

type Keys = null | undefined | string | string[] | Record<string, unknown>;
type Callback = (...args: any[]) => void;

export class ShimStorageArea {
  private cache = new Map<string, string>();
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private backend: KeyValueBackend,
    private settle: Settle
  ) {}

  /** Loads every persisted entry. Must finish before the wallet boots. */
  async load(): Promise<void> {
    const keys = await this.backend.keys();
    const entries = await Promise.all(keys.map(async (key) => [key, await this.backend.get(key)] as const));
    this.cache = new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
  }

  get(keys?: Keys | Callback, callback?: Callback): Promise<Record<string, any>> | undefined {
    if (typeof keys === 'function') return this.settle(this.read(undefined), keys);
    return this.settle(this.read(keys), callback);
  }

  set(items: Record<string, unknown>, callback?: Callback): Promise<void> | undefined {
    return this.settle(this.write(items), callback);
  }

  remove(keys: string | string[], callback?: Callback): Promise<void> | undefined {
    return this.settle(this.delete(keys), callback);
  }

  clear(callback?: Callback): Promise<void> | undefined {
    return this.settle(this.deleteAll(), callback);
  }

  getBytesInUse(keys?: Keys | Callback, callback?: Callback): Promise<number> | undefined {
    let total = 0;
    for (const [key, raw] of this.cache) total += key.length + raw.length;
    return this.settle(Promise.resolve(total), typeof keys === 'function' ? keys : callback);
  }

  private async read(keys?: Keys): Promise<Record<string, any>> {
    // Wait for queued writes so a get issued after a set sees its value.
    await this.writeQueue.catch(() => undefined);
    const result: Record<string, any> = {};
    const read = (key: string) => {
      const raw = this.cache.get(key);
      if (raw !== undefined) result[key] = JSON.parse(raw);
    };

    if (keys === null || keys === undefined) {
      for (const key of this.cache.keys()) read(key);
    } else if (typeof keys === 'string') {
      read(keys);
    } else if (Array.isArray(keys)) {
      keys.forEach(read);
    } else {
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = fallback;
        read(key);
      }
    }
    return result;
  }

  private write(items: Record<string, unknown>): Promise<void> {
    const serialized = Object.entries(items)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, JSON.stringify(value)] as const);
    return this.enqueue(async () => {
      for (const [key, raw] of serialized) {
        await this.backend.set(key, raw);
        this.cache.set(key, raw);
      }
    });
  }

  private delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    return this.enqueue(async () => {
      for (const key of list) {
        await this.backend.remove(key);
        this.cache.delete(key);
      }
    });
  }

  private deleteAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const key of [...this.cache.keys()]) {
        await this.backend.remove(key);
        this.cache.delete(key);
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.catch(() => undefined).then(task);
    this.writeQueue = run;
    return run;
  }
}
