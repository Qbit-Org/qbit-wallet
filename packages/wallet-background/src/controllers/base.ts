/**
 * Base controller class for all wallet controllers
 */

import { EventEmitter } from 'eventemitter3'
export abstract class BaseController extends EventEmitter<any> {
  protected initialized = false

  constructor() {
    super()
    // this.adapters = adapters;
  }

  /**
   * Initialize the controller
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.onInitialize()
    this.initialized = true
  }

  /**
   * Check if controller is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Cleanup controller resources
   */
  async cleanup(): Promise<void> {
    await this.onCleanup()
    this.initialized = false
  }

  /**
   * Override this method to implement initialization logic
   */
  protected abstract onInitialize(): Promise<void>

  /**
   * Override this method to implement cleanup logic
   */
  protected abstract onCleanup(): Promise<void>
}

export default BaseController
