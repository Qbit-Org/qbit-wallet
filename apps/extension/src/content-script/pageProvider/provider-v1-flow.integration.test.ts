import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { P2mrMessageProof } from '@qbit/wallet-shared';

import { QbitProvider } from './qbitProvider';
import type { ProviderEventEmitter, ProviderRequestData } from './types';

const core = vi.hoisted(() => ({
  initializeProvider: vi.fn(),
  requestMethod: vi.fn()
}));

vi.mock('./providerCore', () => core);

const REGTEST_ACCOUNT = 'qbrt1zregtestaccount';
const TESTNET4_ACCOUNT = 'tq1ztestnet4account';
const MESSAGE = 'Qbit V1 integration — exact P2MR bytes';
const UNSIGNED_PSBT = '70736274ff00';
const SIGNED_PSBT = '70736274ff01';
const TXID = 'ab'.repeat(32);
const PROOF = {
  type: 'p2mr-message',
  version: 1,
  address: TESTNET4_ACCOUNT,
  pubkey: '11'.repeat(32),
  signature: '22'.repeat(3680),
  leaf_script: `20${'11'.repeat(32)}b3`,
  control_block: 'c3'
} as P2mrMessageProof;

describe('Qbit V1 provider fixture flow', () => {
  let emit: ProviderEventEmitter;
  let connected = false;
  let chain: 'QBIT_REGTEST' | 'QBIT_TESTNET4' = 'QBIT_REGTEST';
  let account = REGTEST_ACCOUNT;

  beforeEach(() => {
    connected = false;
    chain = 'QBIT_REGTEST';
    account = REGTEST_ACCOUNT;
    core.initializeProvider.mockReset();
    core.requestMethod.mockReset();
    core.initializeProvider.mockImplementation((callback) => {
      emit = callback;
    });
    core.requestMethod.mockImplementation(async ({ method, params }: ProviderRequestData) => {
      if (method === 'requestAccounts') {
        connected = true;
        emit('chainChanged', chain);
        emit('networkChanged', 'regtest');
        emit('accountsChanged', [account]);
        return [account];
      }
      if (method === 'getAccounts') return connected ? [account] : [];
      if (method === 'switchChain') {
        if (!connected) throw new Error('unauthorized origin');
        chain = (params as { chain: 'QBIT_TESTNET4' }).chain;
        account = TESTNET4_ACCOUNT;
        emit('accountsChanged', []);
        emit('chainChanged', chain);
        emit('networkChanged', 'testnet4');
        emit('accountsChanged', [account]);
        return undefined;
      }
      if (!connected) throw new Error('unauthorized origin');
      if (method === 'signMessage') return PROOF;
      if (method === 'verifyMessage') {
        const verify = params as { address: string; text: string; proof: P2mrMessageProof };
        return verify.address === account && verify.text === MESSAGE && verify.proof === PROOF;
      }
      if (method === 'signPsbt') return SIGNED_PSBT;
      if (method === 'pushPsbt') return TXID;
      if (method === 'disconnect') {
        connected = false;
        emit('accountsChanged', []);
        emit('disconnect', { code: 4900, message: 'revoked' });
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
  });

  it('connects, changes chain, signs/verifies P2MR, signs/broadcasts, and durably revokes', async () => {
    const provider = new QbitProvider();
    const events: Array<[string, unknown]> = [];
    provider.on('accountsChanged', (payload) => events.push(['accountsChanged', payload]));
    provider.on('networkChanged', (payload) => events.push(['networkChanged', payload]));
    provider.on('chainChanged', (payload) => events.push(['chainChanged', payload]));
    provider.on('disconnect', (payload) => events.push(['disconnect', payload]));

    await expect(provider.requestAccounts()).resolves.toEqual([REGTEST_ACCOUNT]);
    await expect(provider.switchChain('QBIT_TESTNET4')).resolves.toBeUndefined();
    await expect(provider.signMessage(MESSAGE)).resolves.toBe(PROOF);
    await expect(provider.verifyMessage(TESTNET4_ACCOUNT, MESSAGE, PROOF)).resolves.toBe(true);
    await expect(provider.signPsbt(UNSIGNED_PSBT, { chain: 'QBIT_TESTNET4', autoFinalized: true })).resolves.toBe(
      SIGNED_PSBT
    );
    await expect(provider.pushPsbt(SIGNED_PSBT)).resolves.toBe(TXID);
    await expect(provider.disconnect()).resolves.toBeUndefined();

    expect(events).toEqual([
      ['chainChanged', 'QBIT_REGTEST'],
      ['networkChanged', 'regtest'],
      ['accountsChanged', [REGTEST_ACCOUNT]],
      ['accountsChanged', []],
      ['chainChanged', 'QBIT_TESTNET4'],
      ['networkChanged', 'testnet4'],
      ['accountsChanged', [TESTNET4_ACCOUNT]],
      ['accountsChanged', []],
      ['disconnect', { code: 4900, message: 'revoked' }]
    ]);
    await expect(provider.getAccounts()).resolves.toEqual([]);
    await expect(provider.signMessage(MESSAGE)).rejects.toThrow('unauthorized origin');

    expect(core.requestMethod).toHaveBeenCalledWith({
      method: 'signMessage',
      params: { text: MESSAGE }
    });
    expect(core.requestMethod).toHaveBeenCalledWith({
      method: 'signPsbt',
      params: {
        psbtHex: UNSIGNED_PSBT,
        options: { chain: 'QBIT_TESTNET4', autoFinalized: true }
      }
    });
    expect(core.requestMethod).toHaveBeenCalledWith({
      method: 'pushPsbt',
      params: { psbtHex: SIGNED_PSBT }
    });
  });
});
