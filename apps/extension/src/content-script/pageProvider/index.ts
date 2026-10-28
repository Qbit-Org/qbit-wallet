import { assertProviderCanBeInjected, injectProviderToWindow } from './providerInjection';
import { QbitProvider } from './qbitProvider';

export { QbitProvider } from './qbitProvider';
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
  injectProviderToWindow(new QbitProvider());
} catch (error) {
  console.error('Qbit provider injection failed.', error);
}
