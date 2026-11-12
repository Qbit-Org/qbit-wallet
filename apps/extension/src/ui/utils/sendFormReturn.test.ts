import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChainType } from '@qbit/wallet-types';

import {
  decideSendFormReturn,
  forgetInterruptedSendForm,
  getInterruptedSendForm,
  type InterruptedSendForm,
  noteRedirectToUnlock,
  type SendFormReturnPage
} from './sendFormReturn';

// Only the unlock screen's hook uses the store's hooks; the decision does not.
vi.mock('@qbit/wallet-state', () => ({}));

const ADDRESS = 'qb1zdecisionaccount';
const SEND_FORM_PATH = '/wallet/tx/create';

function storeState(address = ADDRESS, chainType = ChainType.QBIT_MAINNET) {
  return {
    accounts: { current: { address } },
    settings: { chainType }
  } as unknown as Parameters<typeof noteRedirectToUnlock>[1];
}

// Layout's redirect to the unlock screen from `route`, of a screen that was
// shown unlocked unless `shownUnlocked` says otherwise.
function redirectFrom(route: string, page = '/popup.html', state = storeState(), shownUnlocked = true) {
  window.history.replaceState(null, '', `${page}#${route}`);
  noteRedirectToUnlock(SEND_FORM_PATH, state, shownUnlocked);
}

function interruptSendForm(): InterruptedSendForm {
  redirectFrom(SEND_FORM_PATH);
  const form = getInterruptedSendForm();
  if (!form) throw new Error('the send form was not remembered');
  return form;
}

type Selection = { address: string | undefined; chainType: ChainType };

// The page a decision runs in: its store's lock state, and the reads it sends.
function createPage() {
  let unlocked = true;
  const listeners = new Set<() => void>();
  const reads: { resolve: (selection: Selection) => void; reject: (error: unknown) => void }[] = [];
  const page = {
    isUnlocked: () => unlocked,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readSelection: vi.fn(
      () =>
        new Promise<Selection>((resolve, reject) => {
          reads.push({ resolve, reject });
        })
    ),
    go: vi.fn()
  } satisfies SendFormReturnPage;
  const setUnlocked = (next: boolean) => {
    unlocked = next;
    listeners.forEach((listener) => listener());
  };
  const read = (index: number) => {
    const sent = reads[index];
    if (!sent) throw new Error(`read ${index} was not sent`);
    return sent;
  };
  return { page, read, listeners, setUnlocked };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the send form a lock interrupted', () => {
  afterEach(() => {
    forgetInterruptedSendForm();
  });

  it('is remembered from the send form, with the account and network the store had', () => {
    redirectFrom(SEND_FORM_PATH, '/index.html', storeState('qb1zother', ChainType.QBIT_TESTNET4));

    expect(getInterruptedSendForm()).toEqual({ address: 'qb1zother', chainType: ChainType.QBIT_TESTNET4 });
  });

  it.each([['/wallet/tx/create/'], ['/wallet/tx/create?amount=1']])(
    'is remembered from %s, as the router shows it',
    (route) => {
      redirectFrom(route);

      expect(getInterruptedSendForm()).toBeDefined();
    }
  );

  it.each([['/wallet/tx/confirm'], ['/wallet/tx/consolidate'], ['/wallet/tx/create/more'], ['/main'], ['/']])(
    'is forgotten by a redirect from %s',
    (route) => {
      interruptSendForm();

      redirectFrom(route);

      expect(getInterruptedSendForm()).toBeUndefined();
    }
  );

  it('is never remembered in an approval window', () => {
    redirectFrom(SEND_FORM_PATH, '/notification.html');

    expect(getInterruptedSendForm()).toBeUndefined();
  });

  it('is not remembered from a send form this page never showed unlocked, and forgets an earlier one', () => {
    redirectFrom(SEND_FORM_PATH, '/popup.html', storeState(), false);
    expect(getInterruptedSendForm()).toBeUndefined();

    interruptSendForm();
    redirectFrom(SEND_FORM_PATH, '/popup.html', storeState(), false);

    expect(getInterruptedSendForm()).toBeUndefined();
  });

  it('is not remembered before the page has loaded, when the redirect adds no history entry', () => {
    const readyState = vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');
    try {
      redirectFrom(SEND_FORM_PATH);
      expect(getInterruptedSendForm()).toBeUndefined();
    } finally {
      readyState.mockRestore();
    }

    redirectFrom(SEND_FORM_PATH);
    expect(getInterruptedSendForm()).toEqual({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
  });

  it('is written to no storage', () => {
    localStorage.clear();
    sessionStorage.clear();

    interruptSendForm();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('deciding where an unlock goes', () => {
  let hidden = false;

  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  });

  afterEach(() => {
    delete (document as { hidden?: boolean }).hidden;
    forgetInterruptedSendForm();
  });

  it('goes back to the send form for the same account and network, and forgets it', async () => {
    const form = interruptSendForm();
    const { page, read, listeners } = createPage();

    decideSendFormReturn(form, page, false);
    read(0).resolve({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
    await settled();

    expect(page.go).toHaveBeenCalledOnce();
    expect(page.go).toHaveBeenCalledWith('sendForm');
    expect(getInterruptedSendForm()).toBeUndefined();
    expect(listeners.size).toBe(0);
  });

  it.each([
    ['another account', { address: 'qb1zanother', chainType: ChainType.QBIT_MAINNET }],
    ['another network', { address: ADDRESS, chainType: ChainType.QBIT_TESTNET4 }],
    ['no account', { address: undefined, chainType: ChainType.QBIT_MAINNET }]
  ])('goes Home for %s', async (_case, selection) => {
    const form = interruptSendForm();
    const { page, read } = createPage();

    decideSendFormReturn(form, page, false);
    read(0).resolve(selection);
    await settled();

    expect(page.go).toHaveBeenCalledOnce();
    expect(page.go).toHaveBeenCalledWith('home');
    expect(getInterruptedSendForm()).toBeUndefined();
  });

  it('goes Home when a read fails, without reading again', async () => {
    const form = interruptSendForm();
    const { page, read } = createPage();

    decideSendFormReturn(form, page, false);
    // Errors reach the page over the port as plain objects.
    read(0).reject({ message: 'port closed', stack: '' });
    await settled();

    expect(page.go).toHaveBeenCalledWith('home');
    expect(page.readSelection).toHaveBeenCalledOnce();
  });

  it('takes no route when the page locks while the reads are out, and keeps the form', async () => {
    const form = interruptSendForm();
    const { page, read, setUnlocked, listeners } = createPage();

    const decision = decideSendFormReturn(form, page, false);
    setUnlocked(false);
    read(0).resolve({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
    await settled();

    expect(page.go).not.toHaveBeenCalled();
    expect(decision.isRelocked()).toBe(true);
    expect(decision.isPending()).toBe(false);
    expect(getInterruptedSendForm()).toBe(form);
    expect(listeners.size).toBe(0);
  });

  it('takes no route for an earlier unlock when a lock and a new unlock came before its reads', async () => {
    const form = interruptSendForm();
    const { page, read, setUnlocked } = createPage();

    const earlier = decideSendFormReturn(form, page, false);
    setUnlocked(false);
    setUnlocked(true);
    const later = decideSendFormReturn(form, page, false);
    read(1).resolve({ address: 'qb1zanother', chainType: ChainType.QBIT_MAINNET });
    await settled();
    read(0).resolve({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
    await settled();

    expect(earlier.isRelocked()).toBe(true);
    expect(later.isPending()).toBe(false);
    expect(page.go).toHaveBeenCalledOnce();
    expect(page.go).toHaveBeenCalledWith('home');
  });

  it('waits until a hidden page is shown, then reads once', async () => {
    const form = interruptSendForm();
    const { page, read } = createPage();
    hidden = true;

    const decision = decideSendFormReturn(form, page, true);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(page.readSelection).not.toHaveBeenCalled();
    expect(decision.isPending()).toBe(true);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    read(0).resolve({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
    await settled();

    expect(page.readSelection).toHaveBeenCalledOnce();
    expect(page.go).toHaveBeenCalledWith('sendForm');
  });

  it('does not wait for a hidden page when told not to', () => {
    const form = interruptSendForm();
    const { page } = createPage();
    hidden = true;

    decideSendFormReturn(form, page, false);

    expect(page.readSelection).toHaveBeenCalledOnce();
  });

  it('reads at once, and once, when told to stop waiting for a hidden page', async () => {
    const form = interruptSendForm();
    const { page, read } = createPage();
    hidden = true;

    const decision = decideSendFormReturn(form, page, true);
    decision.stopWaiting();
    expect(page.readSelection).toHaveBeenCalledOnce();

    decision.stopWaiting();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    read(0).resolve({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
    await settled();

    expect(page.readSelection).toHaveBeenCalledOnce();
    expect(page.go).toHaveBeenCalledOnce();
    expect(page.go).toHaveBeenCalledWith('sendForm');
  });

  it('reads nothing when told to stop waiting after the page locked, or after a drop', () => {
    const form = interruptSendForm();
    const relockedPage = createPage();
    const droppedPage = createPage();
    hidden = true;

    const relocked = decideSendFormReturn(form, relockedPage.page, true);
    relockedPage.setUnlocked(false);
    relocked.stopWaiting();
    const dropped = decideSendFormReturn(form, droppedPage.page, true);
    dropped.drop();
    dropped.stopWaiting();

    expect(relockedPage.page.readSelection).not.toHaveBeenCalled();
    expect(droppedPage.page.readSelection).not.toHaveBeenCalled();
    expect(relocked.isRelocked()).toBe(true);
    expect(getInterruptedSendForm()).toBe(form);
  });

  it('reads nothing once the page locks while it waits to be shown', () => {
    const form = interruptSendForm();
    const { page, setUnlocked } = createPage();
    hidden = true;

    const decision = decideSendFormReturn(form, page, true);
    setUnlocked(false);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(page.readSelection).not.toHaveBeenCalled();
    expect(decision.isRelocked()).toBe(true);
    expect(getInterruptedSendForm()).toBe(form);
  });

  it('takes no route once dropped', async () => {
    const form = interruptSendForm();
    const { page, read, listeners } = createPage();

    const decision = decideSendFormReturn(form, page, false);
    decision.drop();
    read(0).resolve({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
    await settled();

    expect(page.go).not.toHaveBeenCalled();
    expect(decision.isPending()).toBe(false);
    expect(decision.isRelocked()).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it('takes no route when another redirect replaced the form while the reads were out', async () => {
    const form = interruptSendForm();
    const { page, read } = createPage();

    const decision = decideSendFormReturn(form, page, false);
    interruptSendForm();
    read(0).resolve({ address: ADDRESS, chainType: ChainType.QBIT_MAINNET });
    await settled();

    expect(page.go).not.toHaveBeenCalled();
    expect(decision.isPending()).toBe(false);
  });
});
