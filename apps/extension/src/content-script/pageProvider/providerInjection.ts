const PROVIDER_PROPERTY = 'qbit';

export function assertProviderCanBeInjected(target: Window = window): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, PROVIDER_PROPERTY);
  if (descriptor && !descriptor.configurable) {
    throw new Error('Qbit provider injection blocked by a non-configurable window.qbit property');
  }
}

export function injectProviderToWindow(provider: object, target: Window = window): void {
  assertProviderCanBeInjected(target);
  Object.freeze(provider);
  Object.defineProperty(target, PROVIDER_PROPERTY, {
    value: provider,
    configurable: false,
    enumerable: false,
    writable: false
  });
}
