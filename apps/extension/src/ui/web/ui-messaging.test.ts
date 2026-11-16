import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUS_METHODS, ErrorCodes, MESSAGE_TYPE, PORT_CHANNELS } from '@qbit/wallet-shared';

import PortMessage from '@/shared/utils/message/portMessage';
import { waitForBackgroundReady } from '@/ui/utils/backgroundStartup';
import {
  createReconnectReconcile,
  createUnlockGate,
  createWalletResetHandler,
  forgetShownWalletId,
  getShownWalletId,
  installWalletResetHandler,
  noteWalletIdRead,
  recordShownWalletId,
  refuseWithoutWalletId,
  reopenOutOfDatePage,
  WALLET_ID_MISSING_REOPEN_KEY,
  waitForShownWalletId
} from '@/ui/utils/walletReset';
import { uiEventBus } from '@qbit/wallet-state';

import {
  createPortMessageChannel,
  createWalletProxy,
  setupEventBusListeners,
  UNJUDGED_CONTROLLER_METHODS,
  WALLET_ID_EXEMPT_READS,
  watchPortReconnects
} from './ui-messaging';

type Envelope = { _type_: string; data: { ident?: number; data?: { method?: string; walletId?: unknown } } };
type Answer = { res?: unknown; err?: unknown };

// A port to the background as the page sees it: what it carried, and the
// background answering or going away.
class TestPort {
  posted: Envelope[] = [];
  disconnect = vi.fn();
  // Answers the background gives at once, by method, to what this port carries.
  autoAnswers = new Map<string, Answer>();
  private answered = new Set<number | undefined>();
  private messageListeners: Array<(message: Envelope) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = { addListener: (listener: (message: Envelope) => void) => this.messageListeners.push(listener) };
  onDisconnect = { addListener: (listener: () => void) => this.disconnectListeners.push(listener) };

  postMessage(message: Envelope) {
    const method = message.data?.data?.method ?? '';
    if (goneOnNextPost.delete(method)) {
      // As Chrome says of a port whose other end went away.
      throw new Error('Attempting to use a disconnected port object');
    }
    this.posted.push(message);
    const auto = this.autoAnswers.get(message.data?.data?.method ?? '');
    if (auto) queueMicrotask(() => this.answer(message, auto));
  }

  /** The controller requests this port carried for `method`, as sent. */
  sent(method: string) {
    return this.posted.filter(({ data }) => data?.data?.method === method).map(({ data }) => data.data ?? {});
  }

  /** The wallet methods this port carried, in order. */
  methods(): string[] {
    return this.posted
      .filter(({ _type_ }) => _type_ === `QBIT_WALLET_${MESSAGE_TYPE.REQUEST}`)
      .map(({ data }) => data.data?.method ?? '');
  }

  /** The background answers the oldest request for `method` it has not answered. */
  respond(method: string, answer: Answer) {
    const request = this.posted.find(({ data }) => data?.data?.method === method && !this.answered.has(data.ident));
    if (!request) throw new Error(`no unanswered ${method} request on this port`);
    this.answer(request, answer);
  }

  /** The background broadcasts to the pages, as broadcastToUI does. */
  broadcast(method: string) {
    broadcasts += 1;
    const message = {
      _type_: `QBIT_WALLET_${MESSAGE_TYPE.REQUEST}`,
      data: { ident: 10_000 + broadcasts, data: { type: MESSAGE_TYPE.BG_BROADCAST, method, params: {} } }
    } as unknown as Envelope;
    this.messageListeners.forEach((listener) => listener(message));
  }

  /** The background went away: its service worker stopped or crashed. */
  drop() {
    this.disconnectListeners.forEach((listener) => listener());
  }

  private answer(request: Envelope, answer: Answer) {
    this.answered.add(request.data.ident);
    const message = { _type_: `QBIT_WALLET_${MESSAGE_TYPE.RESPONSE}`, data: { ident: request.data.ident, ...answer } };
    this.messageListeners.forEach((listener) => listener(message));
  }
}

const ports = vi.hoisted(() => [] as unknown[]);
let broadcasts = 0;
// Methods whose next post finds the port gone.
const goneOnNextPost = new Set<string>();

vi.mock('@/background/webapi/browser', () => ({
  browserRuntimeConnect: () => {
    const port = new TestPort();
    ports.push(port);
    return port;
  }
}));

vi.mock('@qbit/wallet-state', () => ({
  resetWalletState: () => ({ type: 'global/resetWalletState' }),
  uiEventBus: { addEventListener: vi.fn(), removeEventListener: vi.fn(), emit: vi.fn() }
}));

const port = (index: number) => ports[index] as TestPort;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchPortReconnects', () => {
  beforeEach(() => {
    ports.length = 0;
    goneOnNextPost.clear();
  });

  it('calls back when the channel announces it replaced a dropped port, never for the first one', async () => {
    const channel = createPortMessageChannel();
    const wallet = createWalletProxy(channel);
    const onReconnect = vi.fn();
    const announced = vi.fn();
    channel.on(PortMessage.RECONNECTED, announced);
    watchPortReconnects(channel, onReconnect);

    void wallet.getAccounts().catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(1);
    expect(announced).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();

    // The port goes with the background, and comes back only with the next
    // request the page sends.
    port(0).drop();
    await settle();
    expect(announced).not.toHaveBeenCalled();
    void wallet.unlock('correct horse').catch(() => undefined);
    expect(announced).toHaveBeenCalledTimes(1);
    // Called once that request is on its way, on the new port.
    expect(onReconnect).not.toHaveBeenCalled();
    await settle();
    expect(ports).toHaveLength(2);
    expect(port(1).methods()).toEqual(['unlock']);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    void wallet.getAccounts().catch(() => undefined);
    await settle();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    port(1).drop();
    void wallet.getAccounts().catch(() => undefined);
    await settle();
    expect(announced).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('posts the request that reconnected first, then what the callback sends', async () => {
    const channel = createPortMessageChannel();
    const wallet = createWalletProxy(channel);
    watchPortReconnects(channel, () => {
      void wallet.isBooted().catch(() => undefined);
    });

    port(0).drop();
    void wallet.unlock('correct horse').catch(() => undefined);
    await settle();

    expect(port(1).methods()).toEqual(['unlock', 'isBooted']);
  });

  // The new port is gone too by the time the callback sends on it.
  it('leaves no request running in the background that nobody waits for when the new port is gone at once', async () => {
    const channel = createPortMessageChannel();
    const wallet = createWalletProxy(channel);
    watchPortReconnects(channel, () => {
      void wallet.isBooted().catch(() => undefined);
    });
    port(0).drop();
    goneOnNextPost.add('isBooted');

    const unlocking = wallet.unlock('correct horse').then(
      () => 'answered',
      (error: { code?: number }) => error
    );
    await settle();

    // The unlock went out on the port that then turned out gone: it may have
    // run, so it is rejected as such, and not sent again. The next port
    // carries only the callback's questions, that one and the next
    // reconnection's.
    expect(port(1).methods()).toEqual(['unlock']);
    expect(port(2).methods()).not.toContain('unlock');
    expect(port(2).methods()).toContain('isBooted');
    expect(await unlocking).toMatchObject({ code: 4900 });
  });

  it('takes a deliberate connect() for no reconnection', async () => {
    const channel = createPortMessageChannel();
    const wallet = createWalletProxy(channel);
    const onReconnect = vi.fn();
    watchPortReconnects(channel, onReconnect);

    channel.connect(PORT_CHANNELS.POPUP);
    void wallet.getAccounts().catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(2);
    expect(port(1).methods()).toEqual(['getAccounts']);
    expect(onReconnect).not.toHaveBeenCalled();

    // The watch stays on for the port connect() opened.
    port(1).drop();
    void wallet.getAccounts().catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(3);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  // How the background uses the class: around the port a page opened, which
  // it never replaces.
  it('is never announced by a PortMessage made around a given port', async () => {
    const pagePort = new TestPort();
    const backgroundSide = new PortMessage(pagePort);
    const announced = vi.fn();
    backgroundSide.on(PortMessage.RECONNECTED, announced);

    const beforeDrop = backgroundSide
      .request({ type: MESSAGE_TYPE.BG_BROADCAST, method: BUS_METHODS.WALLET_RESET })
      .catch((error: unknown) => error);
    expect(pagePort.methods()).toEqual([BUS_METHODS.WALLET_RESET]);

    // The page went away: what was out is lost with it, and what follows is
    // not sent at all, on no new port.
    pagePort.drop();
    expect(await beforeDrop).toMatchObject({ code: 4900 });
    const afterDrop = backgroundSide.request({ type: MESSAGE_TYPE.BG_BROADCAST, method: BUS_METHODS.WALLET_RESET });
    await expect(afterDrop).rejects.toMatchObject({ code: 4900 });

    expect(announced).not.toHaveBeenCalled();
    expect(ports).toHaveLength(0);
    expect(pagePort.methods()).toEqual([BUS_METHODS.WALLET_RESET]);
  });
});

// A background that started again finished a reset this page did not hear
// of: its WALLET_RESET went to the pages connected then. A wallet may have
// been made in another window since.
describe('a page whose connection comes back', () => {
  const STARTUP_WAIT_MS = 400;
  const reload = vi.fn();
  const reloadOnBoot = vi.fn();
  const clearMemory = vi.fn();
  let holdsWallet = true;
  let shownId: string | undefined = 'wallet-a';
  let uninstall: () => void;

  function openPage() {
    const channel = createPortMessageChannel();
    const wallet = createWalletProxy(channel);
    uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload, reloadOnBoot }), {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
    watchPortReconnects(
      channel,
      createReconnectReconcile({
        holdsWallet: () => holdsWallet,
        shownWalletId: () => shownId,
        showsWalletContent: () => false,
        wallet: { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() },
        waitForStartup: () =>
          waitForBackgroundReady(wallet as Parameters<typeof waitForBackgroundReady>[0], STARTUP_WAIT_MS)
      })
    );
    return wallet;
  }

  // The page sits idle while the background stops; the next thing it sends,
  // here an unlock from the lock screen, connects it again.
  async function reconnectWithUnlock(wallet: ReturnType<typeof createWalletProxy>) {
    port(0).drop();
    void wallet.unlock('correct horse').catch(() => undefined);
    await settle();
  }

  // What a background still starting answers: its keyring store is not loaded.
  const notLoaded = { err: { message: 'Cannot read properties of undefined (reading getState)' } };
  const asked = (index: number, method: string) =>
    port(index)
      .methods()
      .filter((name) => name === method).length;
  const UNLOCK_THEN_CHECK = ['unlock', 'isBooted', 'getWalletId'];

  beforeEach(() => {
    ports.length = 0;
    holdsWallet = true;
    shownId = 'wallet-a';
    reload.mockReset();
    reloadOnBoot.mockReset();
    clearMemory.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    uninstall();
  });

  it('lands on Welcome when nothing is booted any more', async () => {
    const wallet = openPage();
    await settle();
    expect(port(0).methods()).toEqual([]);

    await reconnectWithUnlock(wallet);
    expect(port(1).methods()).toEqual(UNLOCK_THEN_CHECK);
    port(1).respond('isBooted', { res: false });
    port(1).respond('getWalletId', { res: null });
    await settle();

    expect(clearMemory).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('changes nothing when the background holds the wallet it shows', async () => {
    const wallet = openPage();

    await reconnectWithUnlock(wallet);
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-a' });
    await settle();

    expect(port(1).methods()).toEqual(UNLOCK_THEN_CHECK);
    expect(clearMemory).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('reopens on the boot route, its wallet dropped, when the background holds another', async () => {
    const wallet = openPage();

    await reconnectWithUnlock(wallet);
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-b' });
    await settle();

    expect(clearMemory).toHaveBeenCalledTimes(1);
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('asks only whether a wallet is set up on a page that recorded no id', async () => {
    shownId = undefined;
    const wallet = openPage();

    await reconnectWithUnlock(wallet);
    expect(port(1).methods()).toEqual(['unlock', 'isBooted']);
    port(1).respond('isBooted', { res: true });
    await settle();

    expect(reloadOnBoot).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('asks nothing on its first connection, nor on a page that holds no wallet', async () => {
    const wallet = openPage();
    void wallet.getAccounts().catch(() => undefined);
    await settle();
    expect(port(0).methods()).toEqual(['getAccounts']);

    holdsWallet = false;
    await reconnectWithUnlock(wallet);

    expect(port(1).methods()).toEqual(['unlock']);
    expect(reload).not.toHaveBeenCalled();
  });

  it('asks again once a background still starting is ready, and reopens on the boot route for another wallet', async () => {
    const wallet = openPage();

    await reconnectWithUnlock(wallet);
    port(1).respond('isBooted', notLoaded);
    port(1).respond('getWalletId', notLoaded);
    await settle();
    // It waits for start-up, asking how it goes, before it asks again.
    expect(port(1).methods()).toEqual([...UNLOCK_THEN_CHECK, 'getBackgroundStartupStatus']);
    port(1).respond('getBackgroundStartupStatus', { res: { state: 'starting' } });
    await settle(100);
    port(1).respond('getBackgroundStartupStatus', { res: { state: 'ready' } });
    await settle();
    expect(port(1).methods()).toEqual([
      ...UNLOCK_THEN_CHECK,
      'getBackgroundStartupStatus',
      'getBackgroundStartupStatus',
      'isBooted',
      'getWalletId'
    ]);
    expect(reloadOnBoot).not.toHaveBeenCalled();
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-b' });
    await settle();

    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('asks again once ready, and changes nothing when the wallet is there', async () => {
    const wallet = openPage();
    await reconnectWithUnlock(wallet);
    port(1).autoAnswers.set('getBackgroundStartupStatus', { res: { state: 'ready' } });

    port(1).respond('isBooted', notLoaded);
    port(1).respond('getWalletId', notLoaded);
    await settle();
    expect(asked(1, 'isBooted')).toBe(2);
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-a' });
    await settle();

    expect(asked(1, 'isBooted')).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();
    expect(clearMemory).not.toHaveBeenCalled();
  });

  it('gives up, changing nothing, when start-up never finishes, and stops asking', async () => {
    const wallet = openPage();
    await reconnectWithUnlock(wallet);
    port(1).autoAnswers.set('getBackgroundStartupStatus', { res: { state: 'starting' } });

    port(1).respond('isBooted', notLoaded);
    port(1).respond('getWalletId', notLoaded);
    await settle(STARTUP_WAIT_MS + 100);
    const sent = port(1).methods().length;
    expect(sent).toBeGreaterThan(4);
    await settle(300);

    expect(port(1).methods()).toHaveLength(sent);
    expect(asked(1, 'isBooted')).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();
    expect(clearMemory).not.toHaveBeenCalled();
  });

  it('changes nothing when the question fails again, or is held', async () => {
    const wallet = openPage();
    await reconnectWithUnlock(wallet);
    port(1).autoAnswers.set('getBackgroundStartupStatus', { res: { state: 'ready' } });

    port(1).respond('isBooted', notLoaded);
    port(1).respond('getWalletId', notLoaded);
    await settle();
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', {
      err: { message: 'Qbit Wallet was reset before this request ran, so it did not run' }
    });
    await settle(50);
    expect(asked(1, 'isBooted')).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();

    // Held behind a reset under way in the background: nothing happens until
    // it is answered, and an answer that the wallet is there changes nothing.
    port(1).drop();
    void wallet.getAccounts().catch(() => undefined);
    await settle();
    expect(port(2).methods()).toEqual(['getAccounts', 'isBooted', 'getWalletId']);
    await settle(50);
    expect(reloadOnBoot).not.toHaveBeenCalled();
    port(2).respond('isBooted', { res: true });
    port(2).respond('getWalletId', { res: 'wallet-a' });
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOnBoot).not.toHaveBeenCalled();
    expect(clearMemory).not.toHaveBeenCalled();
  });

  // The page's unlock waits for the check of its id before it answers.
  describe('unlocked', () => {
    function openUnlockablePage() {
      const channel = createPortMessageChannel();
      let gate: ReturnType<typeof createUnlockGate> | undefined = undefined;
      const wallet = createWalletProxy(channel, { afterUnlock: async () => gate?.afterUnlock() });
      uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload, reloadOnBoot }), {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      });
      gate = createUnlockGate({
        holdsWallet: () => holdsWallet,
        shownWalletId: () => shownId,
        showsWalletContent: () => false,
        isStarted: () => true,
        isUnlocked: () => false,
        wallet: { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() },
        onUnknown: vi.fn(),
        refusal: () => 'The selected wallet is no longer available'
      });
      return wallet;
    }

    it('answers the unlock once the id is the one the page shows', async () => {
      const wallet = openUnlockablePage();
      let answered = false;
      void wallet.unlock('its password').then(() => (answered = true));
      port(0).respond('unlock', { res: undefined });
      await settle();
      expect(answered).toBe(false);
      expect(port(0).methods()).toEqual(['unlock', 'isBooted', 'getWalletId']);

      port(0).respond('isBooted', { res: true });
      port(0).respond('getWalletId', { res: 'wallet-a' });
      await settle();

      expect(answered).toBe(true);
      expect(reloadOnBoot).not.toHaveBeenCalled();
    });

    it('does not answer the unlock of a page that shows another wallet, which reopens on the boot route', async () => {
      const wallet = openUnlockablePage();
      let answered = false;
      void wallet.unlock('the new wallet password').then(() => (answered = true));
      port(0).respond('unlock', { res: undefined });
      await settle();
      port(0).respond('isBooted', { res: true });
      port(0).respond('getWalletId', { res: 'wallet-b' });
      await settle(50);

      expect(reloadOnBoot).toHaveBeenCalledTimes(1);
      expect(clearMemory).toHaveBeenCalledTimes(1);
      expect(answered).toBe(false);
    });
  });
});

// The background's broadcasts, as the page takes them from its port.
describe('setupEventBusListeners', () => {
  const emitted = () => vi.mocked(uiEventBus.emit).mock.calls.map(([method]) => method);

  beforeEach(() => {
    ports.length = 0;
    vi.mocked(uiEventBus.emit).mockReset();
  });

  it('passes broadcasts on at once while nothing is held back', () => {
    const channel = createPortMessageChannel();
    setupEventBusListeners(channel, { beforeUnlocked: async () => true });

    port(0).broadcast(BUS_METHODS.LOCKED);

    expect(emitted()).toEqual([BUS_METHODS.LOCKED]);
  });

  it('holds the UNLOCKED back until the check lets it through, and what comes meanwhile behind it, in order', async () => {
    const channel = createPortMessageChannel();
    let answer!: (go: boolean) => void;
    const beforeUnlocked = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    setupEventBusListeners(channel, { beforeUnlocked });

    port(0).broadcast(BUS_METHODS.UNLOCKED);
    port(0).broadcast(BUS_METHODS.LOCKED);
    await settle();
    expect(beforeUnlocked).toHaveBeenCalledTimes(1);
    expect(emitted()).toEqual([]);

    answer(true);
    await settle();
    expect(emitted()).toEqual([BUS_METHODS.UNLOCKED, BUS_METHODS.LOCKED]);
  });

  it('delivers each broadcast held behind the UNLOCKED, whatever a listener of the one before did', async () => {
    const channel = createPortMessageChannel();
    let answer!: (go: boolean) => void;
    setupEventBusListeners(channel, { beforeUnlocked: () => new Promise<boolean>((resolve) => (answer = resolve)) });
    const failure = new Error('a listener failed');
    vi.mocked(uiEventBus.emit).mockImplementation((method: string) => {
      if (method === BUS_METHODS.LOCKED) throw failure;
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      port(0).broadcast(BUS_METHODS.UNLOCKED);
      port(0).broadcast(BUS_METHODS.LOCKED);
      port(0).broadcast(BUS_METHODS.WALLET_RESET);
      answer(true);
      await settle();

      expect(emitted()).toEqual([BUS_METHODS.UNLOCKED, BUS_METHODS.LOCKED, BUS_METHODS.WALLET_RESET]);
      // Reported, not left as a rejection nobody handles.
      expect(logged).toHaveBeenCalledWith('broadcast listener failed', BUS_METHODS.LOCKED, failure);
    } finally {
      logged.mockRestore();
    }
  });

  it('holds the UNLOCKED back when its check fails, and still passes what comes after it', async () => {
    const channel = createPortMessageChannel();
    setupEventBusListeners(channel, {
      beforeUnlocked: async () => {
        throw new Error('the reopening failed');
      }
    });

    port(0).broadcast(BUS_METHODS.UNLOCKED);
    port(0).broadcast(BUS_METHODS.LOCKED);
    await settle();

    expect(emitted()).toEqual([BUS_METHODS.LOCKED]);
  });

  it('drops the UNLOCKED of a page that reopens, and still passes what comes after it', async () => {
    const channel = createPortMessageChannel();
    setupEventBusListeners(channel, { beforeUnlocked: async () => false });

    port(0).broadcast(BUS_METHODS.UNLOCKED);
    port(0).broadcast(BUS_METHODS.LOCKED);
    await settle();

    expect(emitted()).toEqual([BUS_METHODS.LOCKED]);
  });
});

// Each controller call carries the id of the wallet the page shows; the
// background refuses one from a page whose wallet is no longer set up (-22).
describe('a page that sends the id of the wallet it shows', () => {
  const reload = vi.fn();
  const reloadOnBoot = vi.fn();
  const clearMemory = vi.fn();
  let shownId: string | undefined = 'wallet-a';
  let uninstall: () => void;
  // As the background refuses a call of a page that is out of date.
  const OUT_OF_DATE = {
    err: {
      code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE,
      message: 'This page was showing a wallet that is no longer set up here, so the request was not carried out.'
    }
  };
  // What a background still starting answers: its keyring store is not loaded.
  const notLoaded = { err: { message: 'Cannot read properties of undefined (reading getState)' } };

  // The page as the UI entry wires it; `startup` is how the background's
  // start-up goes for the check after a reconnection.
  function openPage(startup: () => Promise<boolean> = async () => true) {
    const channel = createPortMessageChannel();
    const wallet = createWalletProxy(channel, { walletId: () => shownId, onOutOfDate: reopenOutOfDatePage });
    uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload, reloadOnBoot }), {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
    const checkAfterReconnect = createReconnectReconcile({
      holdsWallet: () => true,
      shownWalletId: () => shownId,
      showsWalletContent: () => false,
      wallet: { isBooted: () => wallet.isBooted(), getWalletId: () => wallet.getWalletId() },
      waitForStartup: startup
    });
    watchPortReconnects(channel, checkAfterReconnect);
    return wallet;
  }

  beforeEach(() => {
    ports.length = 0;
    shownId = 'wallet-a';
    reload.mockReset();
    reloadOnBoot.mockReset();
    clearMemory.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    uninstall();
  });

  it('sends the id with an ordinary call', async () => {
    const wallet = openPage();
    void wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).catch(() => undefined);
    await settle();

    expect(port(0).sent('addContact')).toEqual([
      expect.objectContaining({ type: MESSAGE_TYPE.UI_CONTROLLER, walletId: 'wallet-a' })
    ]);
  });

  it('sends none while it holds no id', async () => {
    shownId = undefined;
    const wallet = openPage();
    void wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).catch(() => undefined);
    await settle();

    expect(port(0).sent('addContact')[0]).not.toHaveProperty('walletId');
  });

  it('sends none with the questions of its check', async () => {
    const wallet = openPage();
    for (const question of ['isBooted', 'getWalletId', 'getBackgroundStartupStatus']) {
      void wallet[question]().catch(() => undefined);
    }
    await settle();

    for (const question of ['isBooted', 'getWalletId', 'getBackgroundStartupStatus']) {
      expect(port(0).sent(question)[0], question).not.toHaveProperty('walletId');
    }
  });

  it('reopens on the boot route at once on a refusal, and leaves the caller the refusal', async () => {
    const wallet = openPage();
    const adding = wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).then(
      () => 'added',
      (error: unknown) => error
    );
    port(0).respond('addContact', OUT_OF_DATE);
    await settle();

    // The background's judgement is enough: no question of the page's own.
    expect(port(0).methods()).toEqual(['addContact']);
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(clearMemory).toHaveBeenCalledTimes(1);
    // The boot route goes on to Welcome when nothing is set up.
    expect(reload).not.toHaveBeenCalled();
    expect(await adding).toMatchObject(OUT_OF_DATE.err);
    expect(port(0).sent('addContact')).toHaveLength(1);
  });

  it('reopens on a refusal while its check waits for the background to start', async () => {
    let started!: (ready: boolean) => void;
    const wallet = openPage(() => new Promise<boolean>((resolve) => (started = resolve)));
    port(0).drop();
    void wallet.getAccounts().catch(() => undefined);
    await settle();
    port(1).respond('isBooted', notLoaded);
    port(1).respond('getWalletId', notLoaded);
    await settle();
    expect(started).toBeTypeOf('function');

    void wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).catch(() => undefined);
    port(1).respond('addContact', OUT_OF_DATE);
    await settle();

    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
  });

  it('reopens on a refusal after its check gave up', async () => {
    const wallet = openPage(async () => false);
    port(0).drop();
    void wallet.getAccounts().catch(() => undefined);
    await settle();
    port(1).respond('isBooted', notLoaded);
    port(1).respond('getWalletId', notLoaded);
    await settle();
    expect(reloadOnBoot).not.toHaveBeenCalled();

    void wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).catch(() => undefined);
    port(1).respond('addContact', OUT_OF_DATE);
    await settle();

    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
  });

  it('leaves the caller the refusal as it came when the reopening throws', async () => {
    uninstall = () => undefined;
    const channel = createPortMessageChannel();
    const failure = new Error('the reload failed');
    const wallet = createWalletProxy(channel, {
      walletId: () => shownId,
      onOutOfDate: () => {
        throw failure;
      }
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const adding = wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).then(
        () => 'added',
        (error: unknown) => error
      );
      port(0).respond('addContact', OUT_OF_DATE);

      expect(await adding).toMatchObject(OUT_OF_DATE.err);
      expect(logged).toHaveBeenCalledWith('reopening a page out of date failed', failure);
    } finally {
      logged.mockRestore();
    }
  });

  it('reopens once for several calls refused together', async () => {
    const wallet = openPage();
    const refusals = ['addContact', 'setAccountAlianName', 'setLastActiveTime'].map((method) =>
      wallet[method]().catch((error: unknown) => error)
    );
    for (const method of ['addContact', 'setAccountAlianName', 'setLastActiveTime']) {
      port(0).respond(method, OUT_OF_DATE);
    }
    await settle();

    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(clearMemory).toHaveBeenCalledTimes(1);
    for (const refusal of await Promise.all(refusals)) {
      expect(refusal).toMatchObject({ code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE });
    }
  });

  // The review bot's scenario: the request that reconnects a page that missed
  // a reset goes out before the page's own check, and would run against the
  // wallet set up since; it carries the id, and the background refuses it.
  it('has the request that reconnects a stale page refused, and reopens the page', async () => {
    const wallet = openPage();
    port(0).drop();
    const adding = wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).then(
      () => 'added',
      (error: unknown) => error
    );
    await settle();
    expect(port(1).methods()).toEqual(['addContact', 'isBooted', 'getWalletId']);
    expect(port(1).sent('addContact')[0]).toMatchObject({ walletId: 'wallet-a' });

    port(1).respond('addContact', OUT_OF_DATE);
    port(1).respond('isBooted', { res: true });
    port(1).respond('getWalletId', { res: 'wallet-b' });
    await settle();

    expect(await adding).toMatchObject({ code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE });
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
  });
});

// The background cannot judge a call that names no wallet: a page that shows
// wallet content sends none without the id of that wallet, as the UI entry
// wires it.
describe('a page that shows wallet content, and the id of its wallet', () => {
  const OUT_OF_DATE_TEXT =
    'This page was showing a wallet that is no longer set up here, so the request was not carried out.';
  const ID_WAIT_MS = 50;
  const reload = vi.fn();
  const reloadOnBoot = vi.fn();
  const clearMemory = vi.fn();
  let content = true;
  let uninstall: () => void = () => undefined;

  function openPage() {
    const channel = createPortMessageChannel();
    return createWalletProxy(channel, {
      walletId: getShownWalletId,
      onOutOfDate: reopenOutOfDatePage,
      showsWalletContent: () => content,
      waitForWalletId: () => waitForShownWalletId(ID_WAIT_MS),
      refuseWithoutWalletId: () => refuseWithoutWalletId(OUT_OF_DATE_TEXT)
    });
  }
  // The page as it opens again in the same window, its handler installed anew.
  function installHandler() {
    uninstall();
    uninstall = installWalletResetHandler(createWalletResetHandler({ clearMemory, reload, reloadOnBoot }), {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    });
  }
  const refusal = (call: Promise<unknown>) =>
    call.then(
      () => 'sent',
      (error: unknown) => error
    );

  beforeEach(() => {
    ports.length = 0;
    content = true;
    forgetShownWalletId();
    reload.mockReset();
    reloadOnBoot.mockReset();
    clearMemory.mockReset();
    sessionStorage.clear();
    installHandler();
  });

  afterEach(() => {
    uninstall();
    uninstall = () => undefined;
    forgetShownWalletId();
    sessionStorage.clear();
  });

  it('sends nothing without the id, refuses it as out of date, reopens once, and reopened, still sends nothing', async () => {
    const wallet = openPage();

    const first = await refusal(wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }));

    expect(port(0).sent('addContact')).toEqual([]);
    expect(first).toEqual({ code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE, message: OUT_OF_DATE_TEXT });
    expect(reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(WALLET_ID_MISSING_REOPEN_KEY)).toBe('1');

    // Reopened in the same window, still without an id: it stays, and still
    // sends nothing of that kind.
    reloadOnBoot.mockReset();
    installHandler();
    const reopened = openPage();
    const again = await refusal(reopened.setAccountAlianName({ address: 'qb1zaccount' }, 'Rent'));

    expect(ports.flatMap((each) => (each as TestPort).sent('setAccountAlianName'))).toEqual([]);
    expect(again).toMatchObject({ code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE });
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('waits for the id read under way, and leaves with the id the page then holds', async () => {
    let endRead!: () => void;
    noteWalletIdRead(new Promise<void>((resolve) => (endRead = resolve)));
    const wallet = openPage();

    const adding = wallet.addContact({ address: 'qb1zfriend', name: 'Friend' });
    await settle();
    expect(port(0).sent('addContact')).toEqual([]);

    recordShownWalletId('wallet-a');
    endRead();
    await settle();

    expect(port(0).sent('addContact')).toEqual([expect.objectContaining({ walletId: 'wallet-a' })]);
    port(0).respond('addContact', { res: true });
    await expect(adding).resolves.toBe(true);
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('refuses once the read under way ends without an id, or stops waiting for it', async () => {
    let endRead!: () => void;
    noteWalletIdRead(new Promise<void>((resolve) => (endRead = resolve)));
    const wallet = openPage();
    const ended = refusal(wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }));
    endRead();
    expect(await ended).toMatchObject({ code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE });

    noteWalletIdRead(new Promise<void>(() => undefined));
    const stuck = refusal(wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }));
    await settle(ID_WAIT_MS + 20);
    expect(await stuck).toMatchObject({ code: ErrorCodes.WALLET_PAGE_OUT_OF_DATE });
    expect(port(0).sent('addContact')).toEqual([]);
  });

  it('sends without an id from a page that shows no wallet content, as the first-run page and a page opened locked do', async () => {
    content = false;
    const wallet = openPage();

    void wallet.createKeyringWithMnemonics('words', 'm/87/0/0/0', '', 9, 1).catch(() => undefined);
    void wallet.unlock('its password').catch(() => undefined);
    await settle();

    expect(port(0).sent('createKeyringWithMnemonics')[0]).not.toHaveProperty('walletId');
    expect(port(0).sent('unlock')[0]).not.toHaveProperty('walletId');
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('always sends the exempt calls, at once, the reads with the id once it holds one', async () => {
    const wallet = openPage();
    const exempt = [...UNJUDGED_CONTROLLER_METHODS, ...WALLET_ID_EXEMPT_READS];
    for (const method of exempt) void wallet[method]().catch(() => undefined);
    expect(exempt.map((method) => port(0).sent(method).length)).toEqual(exempt.map(() => 1));
    for (const method of exempt) expect(port(0).sent(method)[0], method).not.toHaveProperty('walletId');

    recordShownWalletId('wallet-a');
    for (const method of exempt) void wallet[method]().catch(() => undefined);
    for (const method of UNJUDGED_CONTROLLER_METHODS) {
      expect(port(0).sent(method)[1], method).not.toHaveProperty('walletId');
    }
    for (const method of WALLET_ID_EXEMPT_READS) {
      expect(port(0).sent(method)[1], method).toMatchObject({ walletId: 'wallet-a' });
    }
    expect(reloadOnBoot).not.toHaveBeenCalled();
  });

  it('sends with the id at once from a page that holds one, without waiting', () => {
    recordShownWalletId('wallet-a');
    noteWalletIdRead(new Promise<void>(() => undefined));
    const wallet = openPage();

    void wallet.addContact({ address: 'qb1zfriend', name: 'Friend' }).catch(() => undefined);

    expect(port(0).sent('addContact')).toEqual([expect.objectContaining({ walletId: 'wallet-a' })]);
  });
});
