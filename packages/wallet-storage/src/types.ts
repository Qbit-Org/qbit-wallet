export interface PersistentProxyOptions {
  /**
   * Replace the stored data with the template instead of loading it. A proxy
   * created earlier for the same key stops saving first, so its pending save
   * cannot bring the replaced data back.
   */
  reset?: boolean
}

// Storage adapter interface
export interface ProxyStorageAdapter {
  get(key: string): Promise<any>
  set(key: string, value: any): Promise<void>
  createPersistentProxy<T extends object>(
    name: string,
    template: T,
    options?: PersistentProxyOptions
  ): Promise<T>
  /**
   * Save a persistent proxy's data now rather than after its debounce. Rejects
   * when the write fails or a newer proxy has replaced it for its key.
   */
  flushPersistentProxy?(proxy: object): Promise<void>
}
