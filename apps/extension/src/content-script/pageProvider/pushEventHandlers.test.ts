import { describe, expect, it, vi } from 'vitest';

import PushEventHandlers from './pushEventHandlers';
import type { ProviderEventEmitter } from './types';

describe('Qbit provider push events', () => {
  it('normalizes current payloads to the canonical event contract', () => {
    const emit = vi.fn();
    const handlers = new PushEventHandlers(emit as unknown as ProviderEventEmitter);

    handlers.handle('accountsChanged', ['qb1zaccount']);
    handlers.handle('networkChanged', { network: 'mainnet' });
    handlers.handle('chainChanged', { enum: 'QBIT_MAINNET' });
    handlers.handle('disconnect', { code: 4900 });

    expect(emit.mock.calls).toEqual([
      ['accountsChanged', ['qb1zaccount']],
      ['networkChanged', 'mainnet'],
      ['chainChanged', 'QBIT_MAINNET'],
      ['disconnect', { code: 4900 }]
    ]);
  });

  it('drops arbitrary, removed, and malformed events', () => {
    const emit = vi.fn();
    const handlers = new PushEventHandlers(emit as unknown as ProviderEventEmitter);

    handlers.handle('connect', {});
    handlers.handle('close', {});
    handlers.handle('unlock', {});
    handlers.handle('arbitraryEvent', { secret: true });
    handlers.handle('accountsChanged', [123]);
    handlers.handle('networkChanged', 'unsupported');
    handlers.handle('chainChanged', 'OTHER_CHAIN');

    expect(emit).not.toHaveBeenCalled();
  });
});
