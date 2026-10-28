import { describe, expect, it } from 'vitest';

import { injectProviderToWindow } from './providerInjection';

describe('Qbit provider injection', () => {
  it('replaces a configurable page value with one immutable window.qbit provider', () => {
    const target = {} as Window;
    const spoof = { requestAccounts: () => ['spoofed'] };
    Object.defineProperty(target, 'qbit', {
      value: spoof,
      configurable: true,
      writable: true
    });
    const provider = { requestAccounts: () => ['canonical'] };

    injectProviderToWindow(provider, target);

    const descriptor = Object.getOwnPropertyDescriptor(target, 'qbit');
    expect(descriptor).toMatchObject({
      value: provider,
      configurable: false,
      enumerable: false,
      writable: false
    });
    expect(Object.isFrozen(provider)).toBe(true);
    expect((target as Window & Record<string, unknown>).qbit_wallet).toBeUndefined();
    expect(Reflect.deleteProperty(target, 'qbit')).toBe(false);
  });

  it('fails closed and preserves a non-configurable spoof', () => {
    const target = {} as Window;
    const spoof = { requestAccounts: () => ['spoofed'] };
    Object.defineProperty(target, 'qbit', {
      value: spoof,
      configurable: false,
      writable: true
    });

    expect(() => injectProviderToWindow({ requestAccounts: () => ['canonical'] }, target)).toThrow(
      'non-configurable window.qbit'
    );
    expect((target as Window & { qbit: unknown }).qbit).toBe(spoof);
  });
});
