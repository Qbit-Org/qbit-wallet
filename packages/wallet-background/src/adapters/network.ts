/**
 * Network adapter interface for cross-platform network operations
 */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
}

export interface ResponseData<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface NetworkAdapter {
  /**
   * Make HTTP request
   */
  request<T = any>(url: string, options?: RequestOptions): Promise<ResponseData<T>>;
  
  /**
   * GET request
   */
  get<T = any>(url: string, options?: Omit<RequestOptions, 'method'>): Promise<ResponseData<T>>;
  
  /**
   * POST request
   */
  post<T = any>(url: string, data?: any, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<ResponseData<T>>;
  
  /**
   * Check network connectivity
   */
  isOnline(): Promise<boolean>;
  
  /**
   * Get network type (wifi, cellular, etc.)
   */
  getNetworkType?(): Promise<string>;
}