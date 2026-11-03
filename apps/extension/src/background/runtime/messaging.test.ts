import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { approvalService, bgEventBus, preferenceService, walletApiService } from '@qbit/wallet-background';
import { ErrorCodes, MESSAGE_TYPE, PORT_CHANNELS } from '@qbit/wallet-shared';

const EXTENSION_ID = 'wallet';
vi.stubGlobal('chrome', {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`
  }
});

const harness = vi.hoisted(() => {
  const sessions = new Map<unknown, { origin: string; setProp: ReturnType<typeof vi.fn> }>();
  const tabSessions = new Map<number, unknown>();
  return {
    connectListener: undefined as ((port: TestPort) => void) | undefined,
    deleteSession: vi.fn((key: unknown) => {
      sessions.delete(key);
      tabSessions.forEach((sessionKey, tabId) => {
        if (sessionKey === key) {
          tabSessions.delete(tabId);
        }
      });
    }),
    getOrCreateSession: vi.fn((key: unknown, tabId?: number) => {
      let session = sessions.get(key);
      if (!session) {
        session = { origin: '', setProp: vi.fn() };
        sessions.set(key, session);
      }
      if (tabId !== undefined) {
        tabSessions.set(tabId, key);
      }
      return session;
    }),
    getTabSession: (tabId: number) => sessions.get(tabSessions.get(tabId)),
    // This worker's start-up, as the restore module reports it.
    appStateReady: Promise.resolve(),
    handleRequest: vi.fn(),
    listeners: new Map<TestPort, (data: unknown) => unknown>(),
    sessions,
    tabSessions
  };
});

type TestSender = {
  documentLifecycle?: string;
  frameId?: number;
  id?: string;
  origin?: string;
  tab?: { id: number };
  url?: string;
};

type TestPort = {
  disconnect: ReturnType<typeof vi.fn>;
  name: string;
  sender?: TestSender;
  onDisconnect: { addListener: (listener: () => void) => void };
  disconnectListener?: () => void;
};

vi.mock('@/shared/utils/message/portMessage', () => ({
  default: class {
    constructor(private readonly port: TestPort) {}

    listen(listener: (data: unknown) => unknown) {
      harness.listeners.set(this.port, listener);
    }

    request() {
      // This transport stub intentionally does not issue outbound requests.
    }

    send() {
      // This transport stub intentionally does not issue outbound messages.
    }
  }
}));

const walletController = vi.hoisted(() => {
  const controller: Record<string, unknown> & { callingUiPort?: string } = {};
  controller.runForUiPort = vi.fn((uiPort: string, call: () => unknown) => {
    const previous = controller.callingUiPort;
    controller.callingUiPort = uiPort;
    try {
      return call();
    } finally {
      controller.callingUiPort = previous;
    }
  });
  controller.onUiPortDisconnected = vi.fn().mockResolvedValue(undefined);
  // A method that, like signPsbtV2, reads the calling port before its first await.
  controller.signPsbtV2 = vi.fn(async (toSignData: unknown) => ({
    toSignData,
    uiPort: controller.callingUiPort
  }));
  // Real controller members the UI never calls: one TypeScript-private, one
  // destructive.
  controller.performRemoveKeyring = vi.fn();
  controller.resetAllData = vi.fn();
  return controller;
});

vi.mock('@qbit/wallet-background', async () => ({
  // The sender check and the method allowlist are the code under test.
  ...(await vi.importActual<
    Pick<typeof import('@qbit/wallet-background'), 'getUiControllerMethod' | 'isExtensionPageSender'>
  >('../../../../../packages/wallet-background/src/controllers/ui-access')),
  // A real approval service, so a rejection is the one a pending request sees.
  approvalService: new (
    await vi.importActual<typeof import('../../../../../packages/approval-service/src/approval-service')>(
      '../../../../../packages/approval-service/src/approval-service'
    )
  ).ApprovalService(),
  bgEventBus: {
    addEventListener: vi.fn(),
    emit: vi.fn(),
    removeEventListener: vi.fn()
  },
  preferenceService: { setPopupOpen: vi.fn() },
  providerController: { handleRequest: harness.handleRequest },
  sessionService: {
    deleteSession: harness.deleteSession,
    getOrCreateSession: harness.getOrCreateSession
  },
  walletApiService: { setEndpoint: vi.fn() },
  walletController
}));

vi.mock('../init', () => ({
  whenAppStateRestored: () => harness.appStateReady
}));

vi.mock('../webapi/browser', () => ({
  browserRuntimeOnConnect: (listener: (port: TestPort) => void) => {
    harness.connectListener = listener;
  }
}));

import { APP_STATE_WAIT_MS, initMessaging } from './messaging';

beforeEach(() => {
  harness.appStateReady = Promise.resolve();
});

function providerPort(url: string, sender: TestSender = {}): TestPort {
  const port: TestPort = {
    disconnect: vi.fn(),
    name: PORT_CHANNELS.QBIT_PROVIDER,
    sender: { tab: { id: 17 }, url, ...sender },
    onDisconnect: {
      addListener(listener) {
        port.disconnectListener = listener;
      }
    }
  };
  return port;
}

function uiPort(
  name: string,
  sender: TestSender = { id: EXTENSION_ID, tab: { id: 1 }, url: 'chrome-extension://wallet/index.html' }
): TestPort {
  const port: TestPort = {
    disconnect: vi.fn(),
    name,
    sender,
    onDisconnect: {
      addListener(listener) {
        port.disconnectListener = listener;
      }
    }
  };
  return port;
}

describe('background UI-port ownership of send claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.connectListener = undefined;
    harness.listeners.clear();
    initMessaging();
  });

  it('runs each controller call on behalf of the port it arrived on and reports that port on disconnect', async () => {
    const popup = uiPort(PORT_CHANNELS.POPUP);
    const tab = uiPort('tab');
    harness.connectListener!(popup);
    harness.connectListener!(tab);

    const fromPopup = await harness.listeners.get(popup)!({
      type: MESSAGE_TYPE.UI_CONTROLLER,
      method: 'signPsbtV2',
      params: [{ psbtHex: 'aa' }]
    });
    const fromTab = await harness.listeners.get(tab)!({
      type: MESSAGE_TYPE.UI_CONTROLLER,
      method: 'signPsbtV2',
      params: [{ psbtHex: 'bb' }]
    });

    // Two ports of the same worker never share an identity, and the
    // identity a call saw is the one its disconnect reports.
    expect(fromPopup).toEqual({ toSignData: { psbtHex: 'aa' }, uiPort: expect.stringMatching(/^popup:/) });
    expect(fromTab).toEqual({ toSignData: { psbtHex: 'bb' }, uiPort: expect.stringMatching(/^tab:/) });
    expect((fromPopup as any).uiPort).not.toBe((fromTab as any).uiPort);
    expect(walletController.callingUiPort).toBeUndefined();

    popup.disconnectListener!();
    expect(walletController.onUiPortDisconnected).toHaveBeenCalledTimes(1);
    expect(walletController.onUiPortDisconnected).toHaveBeenCalledWith((fromPopup as any).uiPort);

    tab.disconnectListener!();
    expect(walletController.onUiPortDisconnected).toHaveBeenCalledTimes(2);
    expect(walletController.onUiPortDisconnected).toHaveBeenLastCalledWith((fromTab as any).uiPort);
  });

  it('gives a reconnecting page a fresh identity', () => {
    const first = uiPort(PORT_CHANNELS.POPUP);
    harness.connectListener!(first);
    first.disconnectListener!();
    const second = uiPort(PORT_CHANNELS.POPUP);
    harness.connectListener!(second);
    second.disconnectListener!();

    const [[firstId], [secondId]] = vi.mocked(walletController.onUiPortDisconnected as any).mock.calls;
    expect(firstId).not.toBe(secondId);
  });

  it('leaves provider ports out of UI-port ownership', () => {
    const port = providerPort('https://dapp.example/');
    harness.connectListener!(port);
    port.disconnectListener!();

    expect(walletController.onUiPortDisconnected).not.toHaveBeenCalled();
    expect(walletController.runForUiPort).not.toHaveBeenCalled();
  });
});

describe('background UI-port sender check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.connectListener = undefined;
    harness.listeners.clear();
    initMessaging();
  });

  const UI_PORT_NAMES = [PORT_CHANNELS.POPUP, 'notification', 'tab', 'sidepanel'];
  const foreignSenders: Array<[string, TestSender | undefined]> = [
    [
      'a content script on a web page',
      { frameId: 0, id: EXTENSION_ID, origin: 'https://evil.example', tab: { id: 9 }, url: 'https://evil.example/' }
    ],
    ['a content script that reports no origin', { id: EXTENSION_ID, tab: { id: 9 }, url: 'https://evil.example/' }],
    ['a page of another extension', { id: 'other', url: 'chrome-extension://other/index.html' }],
    ['another extension claiming a wallet URL', { id: 'other', url: 'chrome-extension://wallet/index.html' }],
    [
      'a wallet URL whose frame origin disagrees',
      { id: EXTENSION_ID, origin: 'https://evil.example', url: 'chrome-extension://wallet/index.html' }
    ],
    ['the wallet host under another scheme', { id: EXTENSION_ID, url: 'https://wallet/index.html' }],
    ['a look-alike extension host', { id: EXTENSION_ID, url: 'chrome-extension://wallet.evil.example/index.html' }],
    ['an opaque frame', { id: EXTENSION_ID, origin: 'null', url: 'about:blank' }],
    ['a sender without a URL', { id: EXTENSION_ID }],
    ['a malformed URL', { id: EXTENSION_ID, url: 'not a url' }],
    [
      'a wallet page framed by a web page',
      { frameId: 2, id: EXTENSION_ID, tab: { id: 9 }, url: 'chrome-extension://wallet/index.html' }
    ],
    ['no sender at all', undefined]
  ];

  it.each(UI_PORT_NAMES.flatMap((name) => foreignSenders.map(([label, sender]) => [name, label, sender] as const)))(
    'disconnects a %s port from %s without listening to it',
    (name, _label, sender) => {
      const port = uiPort(name);
      port.sender = sender;
      harness.connectListener!(port);

      expect(port.disconnect).toHaveBeenCalledOnce();
      expect(harness.listeners.has(port)).toBe(false);
      expect(port.disconnectListener).toBeUndefined();
      expect(bgEventBus.addEventListener).not.toHaveBeenCalled();
      expect(preferenceService.setPopupOpen).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'the popup',
      { id: EXTENSION_ID, origin: 'chrome-extension://wallet', url: 'chrome-extension://wallet/popup.html' }
    ],
    ['the side panel without a frame origin', { id: EXTENSION_ID, url: 'chrome-extension://wallet/sidepanel.html' }],
    ['a wallet tab', { id: EXTENSION_ID, tab: { id: 3 }, url: 'chrome-extension://wallet/index.html#/main' }]
  ])('serves %s', async (_label, sender) => {
    const port = uiPort(PORT_CHANNELS.POPUP, sender);
    harness.connectListener!(port);

    expect(port.disconnect).not.toHaveBeenCalled();
    expect(preferenceService.setPopupOpen).toHaveBeenCalledWith(true);
    await expect(
      harness.listeners.get(port)!({
        type: MESSAGE_TYPE.UI_CONTROLLER,
        method: 'signPsbtV2',
        params: [{ psbtHex: 'aa' }]
      })
    ).resolves.toEqual({ toSignData: { psbtHex: 'aa' }, uiPort: expect.stringMatching(/^popup:/) });
  });
});

describe('background UI-port controller dispatch', () => {
  let port: TestPort;
  // The transport awaits the listener, so a synchronous throw reaches the
  // page as a rejected request; model that here.
  const request = (data: unknown) => Promise.resolve().then(() => harness.listeners.get(port)!(data));

  beforeEach(() => {
    vi.clearAllMocks();
    harness.connectListener = undefined;
    harness.listeners.clear();
    initMessaging();
    port = uiPort(PORT_CHANNELS.POPUP);
    harness.connectListener!(port);
  });

  it.each([
    'performRemoveKeyring',
    'resetAllData',
    'runForUiPort',
    'onUiPortDisconnected',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    '',
    undefined,
    42
  ])('refuses the non-UI method %s', async (method) => {
    await expect(request({ type: MESSAGE_TYPE.UI_CONTROLLER, method, params: [] })).rejects.toThrow(
      /^Unknown wallet method/
    );

    expect(walletController.performRemoveKeyring).not.toHaveBeenCalled();
    expect(walletController.resetAllData).not.toHaveBeenCalled();
    expect(walletController.runForUiPort).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'aa', { 0: 'aa', length: 1 }])(
    'refuses params %j that are not an array',
    async (params) => {
      await expect(request({ type: MESSAGE_TYPE.UI_CONTROLLER, method: 'signPsbtV2', params })).rejects.toThrow(
        'Invalid wallet request params'
      );
      expect(walletController.signPsbtV2).not.toHaveBeenCalled();
    }
  );

  it('no longer relays UI broadcasts onto the background bus', async () => {
    await expect(
      request({ type: MESSAGE_TYPE.UI_BROADCAST, method: 'broadcastToUI', params: { method: 'walletLocked' } })
    ).rejects.toThrow(/^Unsupported UI message type/);
    expect(bgEventBus.emit).not.toHaveBeenCalled();
  });

  it('no longer exposes the API service to the UI', async () => {
    await expect(
      request({ type: MESSAGE_TYPE.UI_OPENAPI, method: 'setEndpoint', params: ['https://evil.example'] })
    ).rejects.toThrow(/^Unsupported UI message type/);
    expect(walletApiService.setEndpoint).not.toHaveBeenCalled();
  });

  it('refuses a request of unknown type instead of treating it as a controller call', async () => {
    await expect(request({ type: 'something_else', method: 'signPsbtV2', params: [{}] })).rejects.toThrow(
      /^Unsupported UI message type/
    );
    expect(walletController.signPsbtV2).not.toHaveBeenCalled();
  });
});

describe('background provider-port session isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.connectListener = undefined;
    harness.listeners.clear();
    harness.sessions.clear();
    harness.tabSessions.clear();
    initMessaging();
  });

  it('keeps concurrent documents in one tab on distinct sessions', async () => {
    const firstPort = providerPort('https://first.example/');
    const secondPort = providerPort('https://second.example/');
    harness.connectListener!(firstPort);
    harness.connectListener!(secondPort);

    await harness.listeners.get(firstPort)!({
      source: 'page',
      data: { method: 'getAccounts' }
    });
    await harness.listeners.get(secondPort)!({
      source: 'page',
      data: { method: 'getAccounts' }
    });

    const firstRequest = harness.handleRequest.mock.calls[0][0];
    const secondRequest = harness.handleRequest.mock.calls[1][0];
    expect(firstRequest.session).not.toBe(secondRequest.session);
    expect(harness.getOrCreateSession).toHaveBeenCalledWith(firstPort, 17);
    expect(harness.getOrCreateSession).toHaveBeenCalledWith(secondPort, 17);
    expect(harness.getTabSession(17)).toBe(secondRequest.session);
  });

  it('keeps the newest tab session when an older provider port disconnects', () => {
    const firstPort = providerPort('https://first.example/');
    const secondPort = providerPort('https://second.example/');
    harness.connectListener!(firstPort);
    harness.connectListener!(secondPort);

    firstPort.disconnectListener!();

    expect(harness.deleteSession).toHaveBeenCalledOnce();
    expect(harness.deleteSession).toHaveBeenCalledWith(firstPort);
    expect(harness.deleteSession).not.toHaveBeenCalledWith(secondPort);
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(secondPort));
  });

  it('promotes a restored BFCache document without merging its provider session', async () => {
    const firstPort = providerPort('https://first.example/');
    const secondPort = providerPort('https://second.example/');
    harness.connectListener!(firstPort);
    harness.connectListener!(secondPort);

    expect(harness.getTabSession(17)).toBe(harness.sessions.get(secondPort));

    await harness.listeners.get(firstPort)!({
      source: 'content',
      data: { method: 'tabCheckin', params: { name: 'First' } }
    });
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(secondPort));

    await harness.listeners.get(firstPort)!({
      source: 'content',
      data: {
        method: 'tabCheckin',
        params: { name: 'First', activeDocument: true }
      }
    });

    expect(harness.getTabSession(17)).toBe(harness.sessions.get(firstPort));
    expect(harness.sessions.get(firstPort)).not.toBe(harness.sessions.get(secondPort));
  });

  it('keeps the top frame as the tab site when a child frame connects, is restored, or leaves', async () => {
    const pagePort = providerPort('https://dapp.example/', { frameId: 0 });
    const widgetPort = providerPort('https://widget.example/', { frameId: 3 });
    harness.connectListener!(pagePort);
    harness.connectListener!(widgetPort);

    // Only a prerendered page's check-in is asked whether it is the top frame.
    await harness.listeners.get(widgetPort)!({
      source: 'content',
      data: { method: 'tabCheckin', params: { name: 'Widget', topFrame: true, activeDocument: true } }
    });

    const widgetRequest = harness.handleRequest.mock.calls[0][0];
    expect(widgetRequest.session).toBe(harness.sessions.get(widgetPort));
    expect(widgetRequest.session).not.toBe(harness.sessions.get(pagePort));
    expect(harness.getOrCreateSession).toHaveBeenCalledWith(pagePort, 17);
    expect(harness.getOrCreateSession).not.toHaveBeenCalledWith(widgetPort, 17);
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(pagePort));

    widgetPort.disconnectListener!();

    expect(harness.deleteSession).toHaveBeenCalledWith(widgetPort);
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(pagePort));
  });

  it("makes a prerendered page's top frame the tab site once it is shown, and none of its child frames", async () => {
    const pagePort = providerPort('https://dapp.example/', { frameId: 0 });
    const nextPort = providerPort('https://dapp.example/next', { frameId: 4, documentLifecycle: 'prerender' });
    const widgetPort = providerPort('https://widget.example/', { frameId: 5, documentLifecycle: 'prerender' });
    harness.connectListener!(pagePort);
    harness.connectListener!(nextPort);
    harness.connectListener!(widgetPort);

    // Not while it is prerendered and the user still sees the page before it.
    await harness.listeners.get(nextPort)!({
      source: 'content',
      data: { method: 'tabCheckin', params: { name: 'Next', topFrame: true } }
    });
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(pagePort));

    // Once shown, each frame checks in as active, but a child frame is not the top frame.
    await harness.listeners.get(widgetPort)!({
      source: 'content',
      data: { method: 'tabCheckin', params: { name: 'Widget', topFrame: false, activeDocument: true } }
    });
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(pagePort));

    // A page cannot label its own request as the content script's check-in.
    await harness.listeners.get(nextPort)!({
      source: 'page',
      data: { method: 'tabCheckin', params: { name: 'Next', topFrame: true, activeDocument: true } }
    });
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(pagePort));

    await harness.listeners.get(nextPort)!({
      source: 'content',
      data: { method: 'tabCheckin', params: { name: 'Next', topFrame: true, activeDocument: true } }
    });
    expect(harness.getTabSession(17)).toBe(harness.sessions.get(nextPort));
  });
});

describe('background provider-port approvals', () => {
  // As rpcFlow does, the request keeps the id of the approval it waits on
  // with the page that made it.
  function requestApproval(port: TestPort) {
    harness.handleRequest.mockImplementationOnce((req: any) =>
      approvalService.requestApproval({ approvalComponent: 'SignPsbt', origin: req.session.origin }, undefined, (id) =>
        req.page?.approvalIds.add(id)
      )
    );
    const state: { settled: boolean; error?: any } = { settled: false };
    Promise.resolve(harness.listeners.get(port)!({ source: 'page', data: { method: 'sendQbit' } })).then(
      () => Object.assign(state, { settled: true }),
      (error) => Object.assign(state, { settled: true, error })
    );
    return state;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.clearAllMocks();
    harness.connectListener = undefined;
    harness.listeners.clear();
    harness.sessions.clear();
    harness.tabSessions.clear();
    initMessaging();
  });

  afterEach(async () => {
    const approval = approvalService.getApproval();
    if (approval) await approvalService.rejectApproval(approval.id);
  });

  it('rejects the pending approval of a page whose provider port disconnects', async () => {
    const port = providerPort('https://dapp.example/');
    harness.connectListener!(port);
    const request = requestApproval(port);
    await flush();
    expect(approvalService.getApproval()).toBeDefined();

    port.disconnectListener!();
    await flush();

    expect(approvalService.getApproval()).toBeUndefined();
    expect(request.settled).toBe(true);
    expect(request.error).toMatchObject({ code: ErrorCodes.UserCancel });
    // Its requests also learn the page is gone, so none acts on a late result.
    expect(harness.handleRequest.mock.calls[0][0].page.signal.aborted).toBe(true);
    expect(harness.deleteSession).toHaveBeenCalledWith(port);
  });

  it("leaves another page's approval pending when a page disconnects", async () => {
    const firstPort = providerPort('https://first.example/');
    const secondPort = providerPort('https://second.example/');
    harness.connectListener!(firstPort);
    harness.connectListener!(secondPort);
    const request = requestApproval(firstPort);
    await flush();
    const approvalId = approvalService.getApproval()!.id;

    secondPort.disconnectListener!();
    await flush();

    expect(approvalService.getApproval()?.id).toBe(approvalId);
    expect(request.settled).toBe(false);
    expect(harness.handleRequest.mock.calls[0][0].page.signal.aborted).toBe(false);

    firstPort.disconnectListener!();
    await flush();
    expect(approvalService.getApproval()).toBeUndefined();
    expect(request.error).toMatchObject({ code: ErrorCodes.UserCancel });
  });

  it('leaves an approval that replaced a settled one alone', async () => {
    const firstPort = providerPort('https://first.example/');
    const secondPort = providerPort('https://second.example/');
    harness.connectListener!(firstPort);
    harness.connectListener!(secondPort);
    const first = requestApproval(firstPort);
    await flush();
    await approvalService.resolveApproval(approvalService.getApproval()!.id);
    await flush();
    expect(first.settled).toBe(true);
    const second = requestApproval(secondPort);
    await flush();
    const secondId = approvalService.getApproval()!.id;

    firstPort.disconnectListener!();
    await flush();

    expect(approvalService.getApproval()?.id).toBe(secondId);
    expect(second.settled).toBe(false);
  });
});

describe('background provider-port disconnect and the shared unlock request', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  // What the provider flow does with the page a request carries (rpcFlow's
  // own tests run the real flow): a request's own approval goes in
  // page.approvalIds, the unlock request every waiting page shares goes in
  // no page, and a request whose page is gone stops.
  let unlockRequest: Promise<unknown> | undefined;
  function waitForUnlock() {
    unlockRequest ??= approvalService.requestApproval({ lock: true }).finally(() => {
      unlockRequest = undefined;
    });
    return unlockRequest;
  }

  function signAfterUnlock(port: TestPort) {
    harness.handleRequest.mockImplementationOnce(async (req: any) => {
      await waitForUnlock();
      if (req.page.signal.aborted) throw new Error('page gone');
      return approvalService.requestApproval(
        { approvalComponent: 'SignMessage', origin: req.session.origin },
        undefined,
        (id) => req.page.approvalIds.add(id)
      );
    });
    const state: { settled: boolean; error?: any } = { settled: false };
    Promise.resolve(harness.listeners.get(port)!({ source: 'page', data: { method: 'signMessage' } })).then(
      () => Object.assign(state, { settled: true }),
      (error) => Object.assign(state, { settled: true, error })
    );
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    harness.connectListener = undefined;
    harness.listeners.clear();
    harness.sessions.clear();
    harness.tabSessions.clear();
    initMessaging();
  });

  afterEach(async () => {
    const approval = approvalService.getApproval();
    if (approval) await approvalService.rejectApproval(approval.id);
    await flush();
  });

  it("rejects the disconnecting page's own approval and leaves the unlock request pending", async () => {
    const firstPort = providerPort('https://first.example/');
    const secondPort = providerPort('https://second.example/');
    harness.connectListener!(firstPort);
    harness.connectListener!(secondPort);
    harness.sessions.get(firstPort)!.origin = 'https://first.example';
    harness.sessions.get(secondPort)!.origin = 'https://second.example';

    // Both pages wait on the one unlock request.
    const first = signAfterUnlock(firstPort);
    await flush();
    expect(approvalService.getApproval()?.data).toEqual({ lock: true });
    const unlockId = approvalService.getApproval()!.id;
    const second = signAfterUnlock(secondPort);
    await flush();

    firstPort.disconnectListener!();
    await flush();

    // The real disconnect handler leaves the shared unlock request alone.
    expect(approvalService.getApproval()?.id).toBe(unlockId);
    expect(harness.handleRequest.mock.calls[0][0].page.signal.aborted).toBe(true);
    expect(harness.handleRequest.mock.calls[1][0].page.signal.aborted).toBe(false);
    expect(second.settled).toBe(false);

    // Unlocking lets the page that stayed reach its own approval, held by
    // its page; that page's disconnect rejects it.
    await expect(approvalService.resolveApproval(unlockId)).resolves.toBe(true);
    await flush();
    expect(first.error).toMatchObject({ message: 'page gone' });
    expect(approvalService.getApproval()?.data).toMatchObject({
      approvalComponent: 'SignMessage',
      origin: 'https://second.example'
    });
    const signId = approvalService.getApproval()!.id;

    secondPort.disconnectListener!();
    await flush();

    expect(approvalService.getApproval()).toBeUndefined();
    expect(second.error).toMatchObject({ code: ErrorCodes.UserCancel });
    await expect(approvalService.resolveApproval(signId)).resolves.toBe(false);
  });
});

describe('background provider-port requests during start-up', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let finishStartup: (failure?: Error) => void;

  function send(port: TestPort, source: 'page' | 'content', method: string) {
    const state: { settled: boolean; result?: unknown; error?: any } = { settled: false };
    Promise.resolve(harness.listeners.get(port)!({ source, data: { method, params: {} } })).then(
      (result) => Object.assign(state, { settled: true, result }),
      (error) => Object.assign(state, { settled: true, error })
    );
    return state;
  }

  const methodsHandled = () => harness.handleRequest.mock.calls.map(([req]) => req.data.method);

  beforeEach(() => {
    vi.clearAllMocks();
    harness.connectListener = undefined;
    harness.listeners.clear();
    harness.sessions.clear();
    harness.tabSessions.clear();
    harness.appStateReady = new Promise<void>((resolve, reject) => {
      finishStartup = (failure) => (failure ? reject(failure) : resolve());
    });
    harness.appStateReady.catch(() => undefined);
    initMessaging();
  });

  it("answers a connected site's requests made during start-up from the restored wallet, in order", async () => {
    // Until start-up restores the keyring and the site grants, a connected
    // site reads no account.
    let restored = false;
    harness.handleRequest.mockImplementation(async (req: any) => {
      if (req.data.method === 'tabCheckin') return 'ACK_QBIT_PROVIDER_SESSION';
      if (req.data.method === 'getAccounts') return restored ? ['qb1connected'] : [];
      return restored ? 'QBIT_MAINNET' : undefined;
    });
    const port = providerPort('https://dapp.example/');
    harness.connectListener!(port);

    const checkIn = send(port, 'content', 'tabCheckin');
    const accounts = send(port, 'page', 'getAccounts');
    const chain = send(port, 'page', 'getChain');
    await flush();

    // The content script's check-in reads no restored state.
    expect(checkIn).toMatchObject({ settled: true, result: 'ACK_QBIT_PROVIDER_SESSION' });
    expect(accounts.settled).toBe(false);
    expect(chain.settled).toBe(false);
    expect(methodsHandled()).toEqual(['tabCheckin']);

    restored = true;
    finishStartup();
    await flush();

    expect(accounts).toMatchObject({ settled: true, result: ['qb1connected'] });
    expect(chain).toMatchObject({ settled: true, result: 'QBIT_MAINNET' });
    expect(methodsHandled()).toEqual(['tabCheckin', 'getAccounts', 'getChain']);
  });

  it('refuses the requests with a clear error, and runs none, when start-up stops', async () => {
    const port = providerPort('https://dapp.example/');
    harness.connectListener!(port);
    const waiting = send(port, 'page', 'getAccounts');
    await flush();

    finishStartup(new Error('Background start-up failed: stored-settings-unreadable'));
    await flush();
    // A request made once start-up has stopped is refused at once.
    const later = send(port, 'page', 'sendQbit');
    await flush();

    for (const request of [waiting, later]) {
      expect(request.settled).toBe(true);
      expect(request.error).toMatchObject({
        code: -32603,
        message: 'Qbit Wallet could not start. Open Qbit Wallet to see why.'
      });
      // The internal cause stays in the background.
      expect(request.error.message).not.toMatch(/stored-settings/);
    }
    expect(harness.handleRequest).not.toHaveBeenCalled();
  });

  describe('with a time limit', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs a request whose start-up finishes just before the limit', async () => {
      harness.handleRequest.mockResolvedValue(['qb1connected']);
      const port = providerPort('https://dapp.example/');
      harness.connectListener!(port);
      const accounts = send(port, 'page', 'getAccounts');

      await vi.advanceTimersByTimeAsync(APP_STATE_WAIT_MS - 1);
      expect(accounts.settled).toBe(false);
      finishStartup();
      await vi.advanceTimersByTimeAsync(0);

      expect(accounts).toMatchObject({ settled: true, result: ['qb1connected'] });
      // Its timer is gone: passing the limit changes nothing.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(APP_STATE_WAIT_MS);
      expect(harness.handleRequest).toHaveBeenCalledOnce();
    });

    it('refuses a request still waiting at the limit, without running it, and runs the next one once started', async () => {
      harness.handleRequest.mockResolvedValue('txid');
      const port = providerPort('https://dapp.example/');
      harness.connectListener!(port);
      const sending = send(port, 'page', 'sendQbit');

      await vi.advanceTimersByTimeAsync(APP_STATE_WAIT_MS);

      expect(sending.settled).toBe(true);
      expect(sending.error).toMatchObject({
        code: -32002,
        message: 'Qbit Wallet is still starting. Try the request again in a moment.'
      });
      // Start-up finishing later does not run the refused request.
      finishStartup();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.handleRequest).not.toHaveBeenCalled();

      const retried = send(port, 'page', 'sendQbit');
      await vi.advanceTimersByTimeAsync(0);
      expect(retried).toMatchObject({ settled: true, result: 'txid' });
      expect(harness.handleRequest).toHaveBeenCalledOnce();
    });

    it('never runs a request whose page closes while it waits, and drops its timer', async () => {
      const port = providerPort('https://dapp.example/');
      harness.connectListener!(port);
      const sending = send(port, 'page', 'sendQbit');
      await vi.advanceTimersByTimeAsync(1_000);

      port.disconnectListener!();
      await vi.advanceTimersByTimeAsync(0);

      expect(sending.settled).toBe(true);
      expect(sending.error).toBeInstanceOf(Error);
      expect(sending.error.code).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      finishStartup();
      await vi.advanceTimersByTimeAsync(APP_STATE_WAIT_MS);
      expect(harness.handleRequest).not.toHaveBeenCalled();
    });
  });
});
