/**
 * Storage adapter interface for cross-platform storage operations
 */

export interface StorageAdapter {
  /**
   * Get value by key
   */
  get(key: string): Promise<any>;
  
  /**
   * Set value by key
   */
  set(key: string, value: any): Promise<void>;
  
  /**
   * Remove value by key
   */
  remove(key: string): Promise<void>;
  
  /**
   * Clear all storage
   */
  clear(): Promise<void>;
  
  /**
   * Get all keys
   */
  keys(): Promise<string[]>;
  
  /**
   * Check if key exists
   */
  has(key: string): Promise<boolean>;
}