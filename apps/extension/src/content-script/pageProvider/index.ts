import { announceProvider } from './providerAnnouncement';
import { assertProviderCanBeInjected, injectProviderToWindow } from './providerInjection';
import { QbitProvider } from './qbitProvider';

export { QbitProvider } from './qbitProvider';
export type { QbitProviderDetail, QbitProviderInfo } from './providerAnnouncement';
export type {
  P2mrMessageProof,
  QbitBalance,
  QbitChain,
  QbitNetwork,
  QbitProviderEvent,
  QbitProviderEventMap,
  QbitProviderListener,
  QbitSendOptions,
  QbitSignPsbtOptions
} from './types';

declare global {
  interface Window {
    qbit?: QbitProvider;
  }
}

try {
  assertProviderCanBeInjected();
  const provider = new QbitProvider();
  injectProviderToWindow(provider);
  // Only once window.qbit holds the provider. A page without a clear phishing
  // verdict never loads this script, so it hears neither event.
  announceProvider(provider);
} catch (error) {
  console.error('Qbit provider injection failed.', error);
}
