import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { P2mrMessageProof } from '@qbit/wallet-shared';

import { QbitProvider } from './qbitProvider';
import type { ProviderEventEmitter } from './types';

const core = vi.hoisted(() => ({
  initializeProvider: vi.fn(),
  requestMethod: vi.fn()
}));

vi.mock('./providerCore', () => core);

const PROOF = { type: 'p2mr-message', address: 'qb1zaccount' } as P2mrMessageProof;

describe('QbitProvider public boundary', () => {
  let emit: ProviderEventEmitter;

  beforeEach(() => {
    core.requestMethod.mockReset();
    core.initializeProvider.mockReset();
    core.initializeProvider.mockImplementation((callback) => {
      emit = callback;
    });
  });

  it('reflects only the approved public methods and no transport state', () => {
    const provider = new QbitProvider();
    const expectedMethods = [
      'requestAccounts',
      'getAccounts',
      'getPublicKey',
      'getBalance',
      'getNetwork',
      'switchNetwork',
      'getChain',
      'switchChain',
      'signMessage',
      'verifyMessage',
      'signPsbt',
      'signPsbts',
      'pushPsbt',
      'pushTx',
      'sendQbit',
      'disconnect',
      'on',
      'removeListener'
    ];

    expect(Reflect.ownKeys(provider).sort()).toEqual(expectedMethods.sort());
    expect(Object.getOwnPropertySymbols(provider)).toEqual([]);
    expect((provider as unknown as Record<string, unknown>)._request).toBeUndefined();
    expect((provider as unknown as Record<string, unknown>).qbitAPI).toBeUndefined();
    expect((provider as unknown as Record<string, unknown>).emit).toBeUndefined();
    expect((provider as unknown as Record<string, unknown>).getProviderState).toBeUndefined();
    expect((provider as unknown as Record<string, unknown>).keepAlive).toBeUndefined();
  });

  it('routes canonical P2MR and chain-bound PSBT requests', async () => {
    core.requestMethod.mockResolvedValueOnce(PROOF).mockResolvedValueOnce(true).mockResolvedValueOnce('signed');
    const provider = new QbitProvider();

    await expect(provider.signMessage('exact message')).resolves.toBe(PROOF);
    await expect(provider.verifyMessage('qb1zaccount', 'exact message', PROOF)).resolves.toBe(true);
    await expect(provider.signPsbt('70736274', { chain: 'QBIT_TESTNET4', autoFinalized: false })).resolves.toBe(
      'signed'
    );

    expect(core.requestMethod).toHaveBeenNthCalledWith(1, {
      method: 'signMessage',
      params: { text: 'exact message' }
    });
    expect(core.requestMethod).toHaveBeenNthCalledWith(2, {
      method: 'verifyMessage',
      params: { address: 'qb1zaccount', text: 'exact message', proof: PROOF }
    });
    expect(core.requestMethod).toHaveBeenNthCalledWith(3, {
      method: 'signPsbt',
      params: {
        psbtHex: '70736274',
        options: { chain: 'QBIT_TESTNET4', autoFinalized: false }
      }
    });
  });

  it('rejects unsupported chains and incomplete batch bindings before transport', async () => {
    const provider = new QbitProvider();

    await expect(provider.switchChain('OTHER_CHAIN' as never)).rejects.toThrow('Unsupported Qbit chain');
    await expect(provider.signPsbt('70736274', undefined as never)).rejects.toThrow('requires a supported chain');
    await expect(provider.signPsbts(['one', 'two'], [{ chain: 'QBIT_TESTNET4' }])).rejects.toThrow(
      'one options entry per PSBT'
    );
    expect(core.requestMethod).not.toHaveBeenCalled();
  });

  it('delivers only allowlisted events and removes listeners', () => {
    const provider = new QbitProvider();
    const listener = vi.fn();

    provider.on('accountsChanged', listener);
    emit('accountsChanged', ['qb1zaccount']);
    expect(listener).toHaveBeenCalledWith(['qb1zaccount']);

    provider.removeListener('accountsChanged', listener);
    emit('accountsChanged', []);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(() =>
      (provider.on as unknown as (event: string, callback: () => void) => void)('connect', listener)
    ).toThrow('Unsupported Qbit provider event');
  });
});
