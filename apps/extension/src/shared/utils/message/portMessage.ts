import { browserRuntimeConnect } from '@/background/webapi/browser';
import { MESSAGE_TYPE } from '@qbit/wallet-shared';

import Message from './index';

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
    } catch (e) {
      if (!this.reconnect()) {
        this._dispose();
        return;
      }
      try {
        this.port.postMessage({ _type_: `${this._EVENT_PRE}${type}`, data });
      } catch (e) {
        this._dispose();
      }
    }
  };

  dispose = () => {
    this.disposed = true;
    this._dispose();
    this.port?.disconnect();
    this.port = null;
  };
}

export default PortMessage;
