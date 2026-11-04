import { browserRuntimeConnect } from '@/background/webapi/browser';
import { MESSAGE_TYPE } from '@qbit/wallet-shared';
import { ethErrors } from 'eth-rpc-errors';

import Message from './index';

// What postMessage throws when the port itself is gone: Chrome's
// "Attempting to use a disconnected port object" and Firefox's "Attempt to
// postMessage on disconnected port" once the other end disconnected, and
// "Extension context invalidated." once the extension was reloaded or updated
// under this script. Anything else, such as Chrome's "Could not serialize
// message." for a payload holding a BigInt, or "Message length exceeded
// maximum allowed length." for one that is too large, leaves the port working.
const PORT_GONE_ERRORS = [
  'Attempting to use a disconnected port object',
  'Attempt to postMessage on disconnected port',
  'Extension context invalidated'
];

function isPortGone(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && PORT_GONE_ERRORS.some((text) => message.includes(text));
}

class PortMessage extends Message {
  port: any | null = null;
  listenCallback: any;
  private canReconnect = false;
  private connectionName?: string;
  private disposed = false;

  constructor(port?: any) {
    super();

    if (port) {
      this.port = port;
      this.bindPort();
    }
  }

  connect = (name?: string) => {
    this.canReconnect = true;
    this.connectionName = name;
    this.disposed = false;
    this.port = browserRuntimeConnect(undefined, name ? { name } : undefined);
    this.bindPort();

    return this;
  };

  listen = (listenCallback: any) => {
    this.listenCallback = listenCallback;

    return this;
  };

  private bindPort = () => {
    if (!this.port) return;
    const boundPort = this.port;

    boundPort.onMessage.addListener(({ _type_, data }) => {
      if (_type_ === `${this._EVENT_PRE}${MESSAGE_TYPE.PM_BG_TO_CONTENT}`) {
        this.emit(MESSAGE_TYPE.PM_BG_TO_CONTENT, data);
        return;
      }

      if (_type_ === `${this._EVENT_PRE}${MESSAGE_TYPE.RESPONSE}`) {
        this.onResponse(data);
        return;
      }

      if (_type_ === `${this._EVENT_PRE}${MESSAGE_TYPE.REQUEST}`) {
        this.onRequest(data);
      }
    });

    boundPort.onDisconnect?.addListener(() => {
      if (this.port !== boundPort) return;
      this.port = null;
      if (!this.disposed) {
        this._dispose();
      }
    });
  };

  private reconnect = () => {
    if (!this.canReconnect) return false;
    const stalePort = this.port;
    this.connect(this.connectionName);
    if (stalePort && stalePort !== this.port) {
      try {
        stalePort.disconnect();
      } catch {
        // The replacement port is already active; stale-port cleanup is best effort.
      }
    }
    return !!this.port;
  };

  send = (type, data) => {
    if (!this.port && !this.reconnect()) {
      this._dispose();
      return;
    }
    try {
      this.port.postMessage({ _type_: `${this._EVENT_PRE}${type}`, data });
      return;
    } catch (error) {
      if (!isPortGone(error)) {
        this.refuse(type, data, error);
        return;
      }
    }
    // The port is gone, and reconnecting drops it before it reports its
    // disconnect. The requests already sent on it are lost with it; this one
    // never left, so it can go out on the new port.
    this._rejectPending(type === MESSAGE_TYPE.REQUEST ? data?.ident : undefined);
    if (!this.reconnect()) {
      this._dispose();
      return;
    }
    try {
      this.port.postMessage({ _type_: `${this._EVENT_PRE}${type}`, data });
    } catch (error) {
      if (isPortGone(error)) {
        this._dispose();
      } else {
        this.refuse(type, data, error);
      }
    }
  };

  /**
   * A message the port refused while it still works, for example one it could
   * not serialize. Only this message failed: a request is rejected as unsent
   * with Invalid params (-32602), since its payload is what the port could not
   * take, and the port and the other requests carry on.
   */
  private refuse = (type, data, error) => {
    if (type !== MESSAGE_TYPE.REQUEST) return;
    const reason = (error as { message?: unknown } | null)?.message;
    this._rejectRequest(
      data?.ident,
      ethErrors.rpc.invalidParams(
        `The request was not sent to Qbit Wallet and did not run${typeof reason === 'string' ? `: ${reason}` : '.'}`
      )
    );
  };

  dispose = () => {
    this.disposed = true;
    this._dispose();
    this.port?.disconnect();
    this.port = null;
  };
}

export default PortMessage;
