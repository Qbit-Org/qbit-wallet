import log from 'loglevel';

import { initPlatformEnv } from '@/shared/initPlatformEnv';
import { restoreAppState } from './init';
import { initInstallEvent } from './runtime/install';
import { initKeepAlive } from './runtime/keepAlive';
import { initMessaging } from './runtime/messaging';
import { initPhishingDetect } from './runtime/phishingDetect';
import { initSidePanel } from './runtime/sidepanel';
import { initSystemLock } from './runtime/systemLock';
import { initWindow } from './runtime/window';

log.setDefaultLevel('error');
if (process.env.NODE_ENV === 'development') {
  // log.setLevel('debug');
}

// Nothing here awaits, so each init runs while the worker's script first
// runs, and an event it listens for then can start a stopped worker.
async function bootstrap() {
  const restored = restoreAppState();
  restored.then(() => {
    initSidePanel();
  });
  initPlatformEnv();
  initMessaging();
  initInstallEvent();
  initKeepAlive();
  initWindow();
  initPhishingDetect();
  initSystemLock(restored);
}

bootstrap();
