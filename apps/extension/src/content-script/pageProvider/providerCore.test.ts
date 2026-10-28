import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes } from '@qbit/wallet-shared';

const channel = vi.hoisted(() => ({
  request: vi.fn()
}));

vi.mock('@/shared/utils/message/broadcastChannelMessage', () => ({
  default: class {
    connect() {
      return this;
    }

    on() {
      return this;
    }

    request(data: unknown) {
      return channel.request(data);
    }
  }
}));

vi.mock('./providerState', () => ({
  getProviderChannelName: () => 'qbit-provider-test'
}));

import { initializeProvider, requestMethod } from './providerCore';

describe('Qbit provider request errors', () => {
  beforeAll(() => {
    initializeProvider(vi.fn());
  });

  beforeEach(() => {
    channel.request.mockReset();
  });

  it('preserves Error semantics and RPC metadata for a background rejection', async () => {
    const rejection = {
      code: 4100,
      message: 'Origin is not connected to the active Qbit chain',
      data: { chain: 'QBIT_REGTEST' }
    };
    channel.request.mockRejectedValueOnce(rejection);

    let caught: unknown;
    try {
      await requestMethod({ method: 'signMessage', params: { text: 'blocked' } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject(rejection);
  });

  it('passes the unknown broadcast outcome code and its txid through to the dapp', async () => {
    const rejection = {
      code: ErrorCodes.QBIT_BROADCAST_OUTCOME_UNKNOWN,
      message: 'Qbit transaction broadcast outcome is unknown; check the transaction before retrying',
      data: { outcome: 'unknown', chain: 'QBIT_REGTEST', txid: '13'.repeat(32) }
    };
    channel.request.mockRejectedValueOnce(rejection);

    const caught = await requestMethod({ method: 'sendQbit', params: {} }).catch((error) => error);

    // The serializer replaces a code outside its known and server-error
    // ranges with -32603, dropping the data a dapp needs to check the txid.
    expect(caught).toMatchObject(rejection);
  });
});
