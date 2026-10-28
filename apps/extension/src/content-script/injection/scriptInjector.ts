/**
 * Script injection module
 * Handles injection of provider script into page context
 */
import extension from 'extensionizer';
import { nanoid } from 'nanoid';

import { Message } from '@/shared/utils';
import { MESSAGE_TYPE, PORT_CHANNELS } from '@qbit/wallet-shared';

/**
 * Checks the doctype of the current document if it exists
 * @returns true if the doctype is html or if none exists
 */
function doctypeCheck(): boolean {
  const { doctype } = window.document;
  if (doctype) {
    return doctype.name === 'html';
  }
  return true;
}

/**
 * Returns whether or not the extension (suffix) of the current document is prohibited
 * @returns whether or not the extension of the current document is prohibited
 */
function suffixCheck(): boolean {
  const prohibitedTypes = [/\.xml$/u, /\.pdf$/u];
  const currentUrl = window.location.pathname;
  for (let i = 0; i < prohibitedTypes.length; i++) {
    if (prohibitedTypes[i].test(currentUrl)) {
      return false;
    }
  }
  return true;
}

/**
 * Checks the documentElement of the current document
 * @returns true if the documentElement is an html node or if none exists
 */
function documentElementCheck(): boolean {
  const documentElement = document.documentElement.nodeName;
  if (documentElement) {
    return documentElement.toLowerCase() === 'html';
  }
  return true;
}

/**
 * Checks if the current domain is blocked
 * @returns true if the current domain is blocked
 */
function blockedDomainCheck(): boolean {
  const blockedDomains: string[] = [];
  const currentUrl = window.location.href;
  let currentRegex;
  for (let i = 0; i < blockedDomains.length; i++) {
    const blockedDomain = blockedDomains[i].replace('.', '\\.');
    currentRegex = new RegExp(`(?:https?:\\/\\/)(?:(?!${blockedDomain}).)*$`, 'u');
    if (!currentRegex.test(currentUrl)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if the current page is in an iframe
 * @returns true if the page is in an iframe
 */
function iframeCheck(): boolean {
  const isInIframe = self != top;
  return isInIframe;
}

/**
 * Determines if the provider should be injected
 * @returns true if the provider should be injected
 */
export function shouldInjectProvider(): boolean {
  return doctypeCheck() && suffixCheck() && documentElementCheck() && !blockedDomainCheck() && !iframeCheck();
}

function getPageMetadata(): { icon?: string; name: string } {
  const icon =
    (document.querySelector('head > link[rel~="icon"]') as HTMLLinkElement | null)?.href ||
    (document.querySelector('head > meta[itemprop="image"]') as HTMLMetaElement | null)?.content ||
    undefined;
  const name =
    document.title ||
    (document.querySelector('head > meta[name="title"]') as HTMLMetaElement | null)?.content ||
    window.location.hostname;
  return { icon, name };
}

/**
 * Establishes the trusted content/background bridge before exposing the page provider.
 * Page messages are always wrapped by this isolated script, so page code cannot claim an
 * internal source.
 */
export async function injectProviderScript(channelName: string): Promise<void> {
  const { BroadcastChannelMessage, PortMessage } = Message;
  const pm = new PortMessage().connect(PORT_CHANNELS.QBIT_PROVIDER);
  const checkIn = (activeDocument = false) =>
    pm.request({
      source: 'content',
      data: {
        method: 'tabCheckin',
        params: {
          ...getPageMetadata(),
          ...(activeDocument ? { activeDocument: true } : {})
        }
      }
    });
  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted && event.isTrusted) {
      void checkIn(true).catch(() => undefined);
    }
  };
  const bcm = new BroadcastChannelMessage(channelName).listen(async (data) => {
    // PortMessage reconnects lazily after an extension service-worker restart. Checking in
    // first re-establishes the trusted tab-derived origin before forwarding the page request.
    await checkIn();
    return pm.request({ source: 'page', data });
  });
  const dispose = () => {
    window.removeEventListener('pageshow', handlePageShow);
    bcm.dispose();
    pm.dispose();
  };

  pm.on(MESSAGE_TYPE.PM_BG_TO_CONTENT, (data) => {
    bcm.send(MESSAGE_TYPE.BCM_CONTENT_TO_CHANNEL, data);
  });
  document.addEventListener('beforeunload', dispose, { once: true });

  try {
    await checkIn();
    window.addEventListener('pageshow', handlePageShow);

    const container = document.head || document.documentElement;
    const scriptTag = document.createElement('script');
    scriptTag.setAttribute('async', 'false');
    scriptTag.setAttribute('channel', channelName);
    scriptTag.src = extension.runtime.getURL('pageProvider.js');
    container.insertBefore(scriptTag, container.firstChild);
    container.removeChild(scriptTag);
  } catch (error) {
    document.removeEventListener('beforeunload', dispose);
    dispose();
    throw error;
  }
}

/**
 * Initialize script injection if conditions are met
 * @returns The channel name if injected, null otherwise
 */
export async function initializeScriptInjection(): Promise<string | null> {
  if (shouldInjectProvider()) {
    const channelName = nanoid();
    try {
      await injectProviderScript(channelName);
      return channelName;
    } catch (error) {
      console.error('Qbit: Provider injection failed.', error);
    }
  }
  return null;
}
