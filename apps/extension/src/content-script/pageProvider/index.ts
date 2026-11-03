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

function installProvider(): QbitProvider | undefined {
  try {
    assertProviderCanBeInjected();
    const provider = new QbitProvider();
    injectProviderToWindow(provider);
    return provider;
  } catch (error) {
    console.error('Qbit provider injection failed.', error);
    return undefined;
  }
}

const provider = installProvider();
// Only once window.qbit holds the provider. The content script adds this
// script, with a channel it bridges to the background, only to a page with a
// clear phishing verdict. Any page can load pageProvider.js itself, as it is
// web-accessible, but that gains it no connection to the background.
if (provider) {
  try {
    announceProvider(provider);
  } catch (error) {
    // A page that replaced crypto, CustomEvent or dispatchEvent beforehand.
    // window.qbit still works; only the events are missing.
    console.error('Qbit provider is installed, but announcing it failed.', error);
  }
}
