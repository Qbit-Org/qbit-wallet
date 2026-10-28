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
    handleRequest: vi.fn(),
    listeners: new Map<TestPort, (data: unknown) => unknown>(),
    sessions,
    tabSessions
  };
});

type TestSender = {
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

vi.mock('../webapi/browser', () => ({
  browserRuntimeOnConnect: (listener: (port: TestPort) => void) => {
    harness.connectListener = listener;
  }
}));

import { initMessaging } from './messaging';

function providerPort(url: string): TestPort {
  const port: TestPort = {
    disconnect: vi.fn(),
    name: PORT_CHANNELS.QBIT_PROVIDER,
    sender: { tab: { id: 17 }, url },
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
