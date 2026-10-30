/**
 * Minimal `chrome.events.Event` stand-in: an ordered listener list.
 */
export class ShimEvent<T extends (...args: any[]) => any> {
  private listeners: T[] = [];

  addListener(listener: T): void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
  }

  removeListener(listener: T): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  hasListener(listener: T): boolean {
    return this.listeners.includes(listener);
  }

  hasListeners(): boolean {
    return this.listeners.length > 0;
  }

  /** Calls every listener in registration order and returns their results. */
  dispatch(...args: Parameters<T>): ReturnType<T>[] {
    // Copy first so a listener that removes itself does not skip its neighbour.
    return [...this.listeners].map((listener) => listener(...args));
  }
}
