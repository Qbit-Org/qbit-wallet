/**
 * Notification adapter interface for cross-platform notification operations
 */

export interface NotificationOptions {
  title: string;
  message: string;
  iconUrl?: string;
  type?: 'basic' | 'image' | 'list' | 'progress';
  priority?: number;
}

export interface NotificationAdapter {
  /**
   * Create a notification
   */
  create(id: string, options: NotificationOptions): Promise<void>;
  
  /**
   * Clear a notification
   */
  clear(id: string): Promise<void>;
  
  /**
   * Clear all notifications
   */
  clearAll(): Promise<void>;
  
  /**
   * Check if notifications are supported
   */
  isSupported(): boolean;
  
  /**
   * Request notification permission (for web platforms)
   */
  requestPermission?(): Promise<boolean>;
}