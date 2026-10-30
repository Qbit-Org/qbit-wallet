/**
 * Chrome extension APIs return a promise, or take a trailing callback. With a
 * callback, failures are reported through `chrome.runtime.lastError`, which
 * is set only while the callback runs.
 */

export interface LastErrorHolder {
  lastError: undefined | { message: string };
}

export type Settle = <T>(promise: Promise<T>, callback?: unknown) => Promise<T> | undefined;

export function createSettle(holder: LastErrorHolder): Settle {
  return <T>(promise: Promise<T>, callback?: unknown) => {
    if (typeof callback !== 'function') return promise;
    promise.then(
      (value) => callback(value),
      (error) => {
        holder.lastError = { message: error instanceof Error ? error.message : String(error) };
        try {
          callback(undefined);
        } finally {
          holder.lastError = undefined;
        }
      }
    );
    return undefined;
  };
}

/** The trailing function argument, if the caller passed one. */
export function trailingCallback(args: unknown[]): unknown {
  const last = args[args.length - 1];
  return typeof last === 'function' ? last : undefined;
}
