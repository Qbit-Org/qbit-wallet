import PortMessage from '@/shared/utils/message/portMessage';
import {
  approvalService,
  bgEventBus,
  getUiControllerMethod,
  isExtensionPageSender,
  preferenceService,
  providerController,
  sessionService,
  walletController
} from '@qbit/wallet-background';
import { BUS_EVENTS, MESSAGE_TYPE, PORT_CHANNELS } from '@qbit/wallet-shared';
import { browserRuntimeOnConnect } from '../webapi/browser';

// Distinguishes UI ports for the lifetime of this worker. A wallet-built
// send's claim is owned by the port that received its signed bytes, and the
// controller releases what that port still holds when it disconnects.
let uiPortSequence = 0;

const UI_PORT_NAMES = ['popup', 'notification', 'tab', 'sidepanel'];

export function initMessaging() {
  // for page provider
  browserRuntimeOnConnect((port) => {
    const portName = port.name;

    if (portName === 'CT_Internal_port_alive') {
      return;
    }

    // Any content script can open a port under a UI name, so the name alone
    // says nothing about who holds the other end. Only the wallet's own pages
    // may drive the controller; refuse anything else before listening to it.
    const isUiPort = UI_PORT_NAMES.includes(portName);
    if (isUiPort && !isExtensionPageSender(port.sender)) {
      port.disconnect();
      return;
    }

    const pm = new PortMessage(port as any);

    // UI ports
    if (isUiPort) {
      const uiPortId = `${portName}:${++uiPortSequence}`;
      // listen the message from UI
      pm.listen((data) => {
        if (!data?.type) return;
        switch (data.type) {
          case MESSAGE_TYPE.UI_REQUEST_METHOD:
            if (process.env.NODE_ENV === 'development') {
              return providerController.handleRequest(data.params);
            } else {
              throw new Error('UI_REQUEST_METHOD is only available in development mode');
            }
          case MESSAGE_TYPE.UI_CONTROLLER: {
            const method = getUiControllerMethod(walletController, data.method);
            if (!Array.isArray(data.params)) {
              throw new Error('Invalid wallet request params');
            }
            // Run on behalf of this port so a send claim minted or
            // broadcast by the call is tied to the page holding its bytes.
            return walletController.runForUiPort(uiPortId, () => method(...data.params));
          }
          default:
            throw new Error(`Unsupported UI message type: ${data.type}`);
        }
      });

      // push the message to UI
      const broadcastToUI = (data: any) => {
        pm.request({
          type: MESSAGE_TYPE.BG_BROADCAST,
          method: data.method,
          params: data.params
        });
      };

      bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, broadcastToUI);

      port.onDisconnect.addListener(() => {
        bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, broadcastToUI);
        if (portName === PORT_CHANNELS.POPUP) {
          preferenceService.setPopupOpen(false);
        }
        // The page is gone, and with it any signed bytes it was holding for
        // a broadcast or a retry. Fire and forget: the guard queues the
        // release behind whatever broadcast that page may have in flight.
        void walletController.onUiPortDisconnected(uiPortId).catch(() => undefined);
      });

      if (portName === PORT_CHANNELS.POPUP) {
        preferenceService.setPopupOpen(true);
      }

      return;
    } else if (portName === PORT_CHANNELS.QBIT_PROVIDER) {
      const tabId = port.sender?.tab?.id;
      if (!Number.isInteger(tabId)) {
        port.disconnect();
        return;
      }

      // A Port is bound to one sender document. Using it as the session key
      // prevents same-tab navigations, BFCache documents, or reconnects from
      // sharing mutable origin and approval context.
      const sessionKey = port as object;
      const session = sessionService.getOrCreateSession(sessionKey, tabId) as any;

      // The document behind this port, as its requests see it: each keeps the
      // id of the approval it waits on here. When the port disconnects, those
      // approvals are rejected and the requests stop before anything is
      // signed or sent for a page that is gone.
      const pageGone = new AbortController();
      const page = { signal: pageGone.signal, approvalIds: new Set<string>() };

      // Qbit page-provider port. The isolated content script wraps every
      // page request, so a page cannot label its own request as internal.
      pm.listen(async (envelope) => {
        if (
          !envelope ||
          (envelope.source !== 'page' && envelope.source !== 'content') ||
          !envelope.data ||
          typeof envelope.data.method !== 'string'
        ) {
          throw new Error('Invalid Qbit provider request envelope');
        }

        const req = { source: envelope.source, data: envelope.data, session, port, page };
        // for background push to respective page
        req.session.pushMessage = (event, data) => {
          // Send a message to the page( SESSION_EVENTS)
          // example:  sessionService.broadcastEvent(SESSION_EVENTS.unlock)
          pm.send(MESSAGE_TYPE.PM_BG_TO_CONTENT, { event, data });
        };

        // Handle the request before changing the tab alias so only a trusted,
        // sender-bound check-in can select this document as current.
        const result = await providerController.handleRequest(req);
        if (
          envelope.source === 'content' &&
          envelope.data.method === 'tabCheckin' &&
          envelope.data.params?.activeDocument === true
        ) {
          sessionService.getOrCreateSession(sessionKey, tabId);
        }
        return result;
      });

      port.onDisconnect.addListener(() => {
        pageGone.abort();
        // Only this page's approvals: another page's request, or the unlock
        // request every page shares, stays pending.
        for (const approvalId of page.approvalIds) {
          void approvalService
            .rejectApproval(approvalId, 'The page that made this request is gone')
            .catch(() => undefined);
        }
        page.approvalIds.clear();
        sessionService.deleteSession(sessionKey);
      });

      return;
    }

    // Ignore unknown extension ports. They are not provider transports.
  });
}
