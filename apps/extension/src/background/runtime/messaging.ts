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
import { ethErrors } from 'eth-rpc-errors';
import { whenAppStateRestored } from '../init';
import { browserRuntimeOnConnect } from '../webapi/browser';

// Distinguishes UI ports for the lifetime of this worker. A wallet-built
// send's claim is owned by the port that received its signed bytes, and the
// controller releases what that port still holds when it disconnects.
let uiPortSequence = 0;

const UI_PORT_NAMES = ['popup', 'notification', 'tab', 'sidepanel'];

// How long a site's request waits for start-up. A healthy start reads local
// storage and loads the bundled PQC code in well under a second; its only
// network step, the regtest check, gives up after two 3-second probes. A
// start-up still running after 30 seconds has stalled, and the site is better
// told to try again than left waiting.
export const APP_STATE_WAIT_MS = 30_000;

/**
 * Waits until this worker has restored the wallet. Until then no keyring or
 * site grant is loaded, and a site would read a connected wallet as empty or
 * as having no account. The request fails without running when start-up has
 * stopped, is still running after APP_STATE_WAIT_MS, or its page goes away.
 * A failed start-up's internal cause stays with the wallet's own pages.
 */
function waitForAppState(page: { signal: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      page.signal.removeEventListener('abort', onPageGone);
      settle();
    };
    const onPageGone = () => finish(() => reject(new Error('Qbit provider page closed before the request completed')));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            ethErrors.rpc.resourceUnavailable({
              message: 'Qbit Wallet is still starting. Try the request again in a moment.'
            })
          )
        ),
      APP_STATE_WAIT_MS
    );
    page.signal.addEventListener('abort', onPageGone, { once: true });
    if (page.signal.aborted) onPageGone();
    whenAppStateRestored().then(
      () => finish(resolve),
      () =>
        finish(() =>
          reject(ethErrors.rpc.internal({ message: 'Qbit Wallet could not start. Open Qbit Wallet to see why.' }))
        )
    );
  });
}

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
            // broadcast by the call is tied to the page holding its bytes;
            // a call made while a reset runs waits for it there. The id of
            // the wallet the page shows goes along only when the page sent
            // one, and the controller judges it, its type included.
            const call = () => method(...data.params);
            return Object.prototype.hasOwnProperty.call(data, 'walletId')
              ? walletController.runForUiPort(uiPortId, call, data.method, data.walletId)
              : walletController.runForUiPort(uiPortId, call, data.method);
          }
          default:
            throw new Error(`Unsupported UI message type: ${data.type}`);
        }
      });

      // push the message to UI. Nothing waits for the answer: a page that
      // closes first rejects it, and a port that refuses the message (no
      // request ids left) throws, which must not stop the other pages'
      // listeners on the same event.
      const broadcastToUI = (data: any) => {
        try {
          void Promise.resolve(
            pm.request({
              type: MESSAGE_TYPE.BG_BROADCAST,
              method: data.method,
              params: data.params
            })
          ).catch(() => undefined);
        } catch {
          // This page misses the message; the others still get it.
        }
      };

      bgEventBus.addEventListener(BUS_EVENTS.broadcastToUI, broadcastToUI);

      // A message for this page only, such as the progress of a signing it
      // asked for; every other page drops it.
      const sendToThisUI = (data?: { port?: unknown; method?: string; params?: unknown }) => {
        if (data?.port !== uiPortId) return;
        broadcastToUI(data);
      };

      bgEventBus.addEventListener(BUS_EVENTS.toUIPort, sendToThisUI);

      port.onDisconnect.addListener(() => {
        bgEventBus.removeEventListener(BUS_EVENTS.broadcastToUI, broadcastToUI);
        bgEventBus.removeEventListener(BUS_EVENTS.toUIPort, sendToThisUI);
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
      // Only a top-frame document stands for the tab, whose site the popup
      // shows as current. A child frame, such as an embedded widget, keeps
      // its own session under its own origin but never becomes the tab's site.
      // The browser numbers the top frame 0, except in a page Chrome
      // prerenders, where every frame connects under another number; there
      // the top frame says so itself when it checks in on being shown, and
      // until then no document of the page is the tab's top frame.
      const sender: { frameId?: number; documentLifecycle?: string } | undefined = port.sender;
      const isTabTopFrame = (checkIn?: { topFrame?: unknown }) =>
        sender?.documentLifecycle === 'prerender'
          ? checkIn?.topFrame === true
          : sender?.frameId === undefined || sender.frameId === 0;
      const session = sessionService.getOrCreateSession(sessionKey, isTabTopFrame() ? tabId : undefined) as any;

      // The document behind this port, as its requests see it: each keeps the
      // id of the approval it waits on here. When the port disconnects, those
      // approvals are rejected, and a request whose provider method has not
      // started never runs it; one already signing or sending completes.
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

        // The content script's check-in reads no restored state, so it is
        // answered at once; a page's request waits for start-up.
        if (envelope.source === 'page') {
          await waitForAppState(page);
        }

        // Handle the request before changing the tab alias so only a trusted,
        // sender-bound check-in can select this document as current.
        const result = await providerController.handleRequest(req);
        if (
          envelope.source === 'content' &&
          envelope.data.method === 'tabCheckin' &&
          envelope.data.params?.activeDocument === true &&
          isTabTopFrame(envelope.data.params)
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
