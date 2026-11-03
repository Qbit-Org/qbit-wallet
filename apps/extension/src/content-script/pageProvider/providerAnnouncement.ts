/**
 * Tells a page that window.qbit is ready, after EIP-6963. These events are
 * for detection only: a page can dispatch any of them itself, so access still
 * comes only from requestAccounts().
 */
export const PROVIDER_INITIALIZED_EVENT = 'qbit#initialized';
export const ANNOUNCE_PROVIDER_EVENT = 'qbit:announceProvider';
export const REQUEST_PROVIDER_EVENT = 'qbit:requestProvider';

export const PROVIDER_NAME = 'Qbit Wallet';
// The wallet's reverse-DNS identifier, under qbit.org.
export const PROVIDER_RDNS = 'org.qbit.wallet';
// The extension's own 128px icon, build/_raw/images/logo/logo@128x.png.
export const PROVIDER_ICON =
  'data:image/png;base64,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';

export interface QbitProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

export interface QbitProviderDetail {
  readonly info: QbitProviderInfo;
  readonly provider: object;
}

/**
 * A version 4 UUID. crypto.randomUUID exists only in a secure context, and an
 * http: page gets a provider too, so this uses getRandomValues.
 */
export function createProviderUuid(random: Pick<Crypto, 'getRandomValues'> = crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Dispatches qbit#initialized, then announces the provider, and announces it
 * again whenever the page asks, so a page that starts listening late still
 * finds it. Call it only once window.qbit holds this provider.
 */
export function announceProvider(provider: object, target: Window = window): void {
  const info: QbitProviderInfo = Object.freeze({
    uuid: createProviderUuid(),
    name: PROVIDER_NAME,
    icon: PROVIDER_ICON,
    rdns: PROVIDER_RDNS
  });
  const detail: QbitProviderDetail = Object.freeze({ info, provider });
  const announce = () => {
    target.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail }));
  };

  // Before the first event, so that a page asking from its handler is answered.
  target.addEventListener(REQUEST_PROVIDER_EVENT, announce);
  target.dispatchEvent(new Event(PROVIDER_INITIALIZED_EVENT));
  announce();
}
