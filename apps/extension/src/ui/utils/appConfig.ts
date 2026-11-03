/**
 * Application Configuration
 * Centralized configuration for the UI application
 */
import log from 'loglevel';

/**
 * Configure logging based on environment
 */
export function setupLogging(): void {
  log.setDefaultLevel('error');
  if (process.env.NODE_ENV === 'development') {
    log.setLevel('debug');
  }
}

/**
 * Initialize all application configurations
 */
export function initializeAppConfig(): void {
  setupLogging();
}
