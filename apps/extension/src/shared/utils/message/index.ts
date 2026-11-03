/**
 * this script is live in content-script / dapp's page
 */
import { MESSAGE_TYPE } from '@qbit/wallet-shared';
import { ethErrors } from 'eth-rpc-errors';
import { EventEmitter } from 'events';

abstract class Message extends EventEmitter {
  // available id list
  // max concurrent request limit
  private _requestIdPool = [...Array(500).keys()];
  protected _EVENT_PRE = 'QBIT_WALLET_';
  protected listenCallback: any;

  private _waitingMap = new Map<
    number,
    {
      data: any;
      resolve: (arg: any) => any;
      reject: (arg: any) => any;
    }
  >();

  abstract send(type: string, data: any): void;

  request = (data) => {
    if (!this._requestIdPool.length) {
      throw ethErrors.rpc.limitExceeded();
    }
    const ident = this._requestIdPool.shift()!;

    return new Promise((resolve, reject) => {
      this._waitingMap.set(ident, {
        data,
        resolve,
        reject
      });

      this.send(MESSAGE_TYPE.REQUEST, { ident, data });
    });
  };

  onResponse = async ({ ident, res, err }: any = {}) => {
    // the url may update
    if (!this._waitingMap.has(ident)) {
      return;
    }

    const { resolve, reject } = this._waitingMap.get(ident)!;

    this._requestIdPool.push(ident);
    this._waitingMap.delete(ident);
    err ? reject(err) : resolve(res);
  };

  onRequest = async ({ ident, data }) => {
    if (this.listenCallback) {
      let res, err;

      try {
        res = await this.listenCallback(data);
      } catch (e: any) {
        err = {
          message: e.message,
          stack: e.stack
        };
        e.code && (err.code = e.code);
        e.data && (err.data = e.data);
      }

      this.send(MESSAGE_TYPE.RESPONSE, { ident, res, err });
    }
  };

  /**
   * Rejects every request still waiting for its answer, except `keep`, once
   * the connection that carried them is gone. The other side may have run
   * them already, so the rejection is EIP-1193's Disconnected (4900), not the
   * user's rejection (4001), and none of them is sent again.
   */
  protected _rejectPending = (keep?: number) => {
    for (const ident of [...this._waitingMap.keys()]) {
      if (ident === keep) continue;
      this._rejectRequest(
        ident,
        ethErrors.provider.disconnected(
          'The connection to Qbit Wallet closed before the request finished, so it may have run.'
        )
      );
    }
  };

  /** Rejects the request `ident` with `error`, if it still waits for its answer. */
  protected _rejectRequest = (ident: number, error: unknown) => {
    const request = this._waitingMap.get(ident);
    if (!request) return;
    this._requestIdPool.push(ident);
    this._waitingMap.delete(ident);
    request.reject(error);
  };

  _dispose = () => {
    this._rejectPending();
  };
}

export default Message;
