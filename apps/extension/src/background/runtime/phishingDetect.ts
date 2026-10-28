import { phishingController } from '@qbit/wallet-background';

export function initPhishingDetect() {
  // Initialize phishing detector
  phishingController.init();
}
