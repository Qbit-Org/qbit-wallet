import { describe, expect, it } from 'vitest';

import { ErrorCodes, MESSAGE_TYPE, WalletError } from '@qbit/wallet-shared';

import Message from './index';

class LoopbackMessage extends Message {
  peer?: LoopbackMessage;

  listen(callback: (data: any) => unknown) {
    this.listenCallback = callback;
  }

  send(type: string, data: any) {
    if (type === MESSAGE_TYPE.REQUEST) {
      void this.peer!.onRequest(data);
    } else if (type === MESSAGE_TYPE.RESPONSE) {
      void this.peer!.onResponse(data);
    }
  }
}

function linkedPair() {
  const ui = new LoopbackMessage();
  const background = new LoopbackMessage();
  ui.peer = background;
  background.peer = ui;
  return { ui, background };
}

describe('message request/response error serialization', () => {
  it('preserves the stable error code the UI selects behavior by', async () => {
    const { ui, background } = linkedPair();
    background.listen(() => {
      throw new WalletError(
        ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS,
        'Protected assets must be moved separately before archiving this wallet'
      );
    });

    await expect(ui.request({ method: 'prepareQbitRecoveryMigration' })).rejects.toMatchObject({
      code: ErrorCodes.QBIT_RECOVERY_PROTECTED_ASSETS
    });
  });

  it('serializes untyped errors without inventing a code', async () => {
    const { ui, background } = linkedPair();
    background.listen(() => {
      throw new Error('internal migration detail');
    });

    const rejection = await ui.request({ method: 'prepareQbitRecoveryMigration' }).then(
      () => {
        throw new Error('expected the request to reject');
      },
      (error) => error as { message: string; code?: unknown }
    );
    expect(rejection.message).toBe('internal migration detail');
    expect('code' in rejection).toBe(false);
  });
});
