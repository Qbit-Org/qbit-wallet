/**
 * Unlocking returns to the send form a lock interrupted: the page's real
 * store, router (MainRoute's HashRouter and routes), Layout, unlock screen and
 * send form, with the background behind the wallet controller and the
 * heavier screens (Home, confirm, consolidation) stood in for.
 */
import { useEffect } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Layout } from '@/ui/components/Layout';
import Main from '@/ui/pages/MainRoute';
import {
  forgetInterruptedSendForm,
  getInterruptedSendForm,
  SEND_FORM_RETURN_FALLBACK_MS
} from '@/ui/utils/sendFormReturn';
import { forgetShownWalletId, getShownWalletId, reopenOutOfDatePage } from '@/ui/utils/walletReset';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BUS_METHODS, KeyringType } from '@qbit/wallet-shared';
import {
  AccountUpdater,
  createAppStore,
  uiActions,
  uiEventBus,
  useIsUnlocked,
  useNavigation,
  useResetFeeRateBar,
  useResetUiTxCreateScreen,
  WalletProvider
} from '@qbit/wallet-state';
import { AddressType, ChainType } from '@qbit/wallet-types';

import { installPageChecks } from './support/pageChecks';

// The extension APIs some screens reach for as they load; none of them takes
// part here: every property is another such stand-in, every call does nothing.
vi.hoisted(() => {
  const extensionApi = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => (key === 'then' ? undefined : extensionApi()),
      apply: () => undefined
    });
  (globalThis as { chrome?: unknown }).chrome = extensionApi();
});

// Touch ID, as the browser offers it to the page: available, and each prompt
// open until the test ends it. The page asks once whether it is available and
// keeps the answer, so this is in place before any test runs; the unlock
// screen offers it only for a wallet that enrolled it.
const touchIdPrompts = vi.hoisted(() => {
  const prompts: { end: (error: unknown) => void }[] = [];
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window, 'PublicKeyCredential', {
    configurable: true,
    value: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true }
  });
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      get: () =>
        new Promise((_resolve, reject) => {
          prompts.push({ end: reject });
        })
    }
  });
  return prompts;
});

const visits = vi.hoisted(() => ({ home: 0 }));

vi.mock('@/ui/pages/Main/WalletTabScreen', () => ({ default: () => <HomeStandIn /> }));
vi.mock('@/ui/pages/Wallet/TxConfirmScreen', () => ({ default: () => <ScreenStandIn testId="confirm-screen" /> }));
vi.mock('@/ui/pages/Wallet/QbitConsolidationScreen', () => ({
  default: () => <ScreenStandIn testId="consolidation-screen" />
}));

// Home as far as this test needs it: Send clears the form before opening it,
// as WalletActions does, and a lock on Home also asks for the unlock screen,
// as WalletTabScreen does.
function HomeStandIn() {
  const nav = useNavigation();
  const isUnlocked = useIsUnlocked();
  const resetUiTxCreateScreen = useResetUiTxCreateScreen();
  const resetFeeRateBar = useResetFeeRateBar();
  useEffect(() => {
    visits.home++;
  }, []);
  useEffect(() => {
    if (!isUnlocked) nav.navToLock({ autoUnlockByFace: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as WalletTabScreen does
  }, [isUnlocked]);
  return (
    <Layout>
      <div data-testid="home-screen" />
      <button
        data-testid="send-button"
        onClick={() => {
          resetUiTxCreateScreen();
          resetFeeRateBar();
          nav.navigate('TxCreateScreen');
        }}
      />
    </Layout>
  );
}

function ScreenStandIn({ testId }: { testId: string }) {
  return (
    <Layout>
      <div data-testid={testId} />
    </Layout>
  );
}

// A mainnet P2MR address the send form accepts.
const RECIPIENT = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw';
const FEE_SUMMARY = {
  list: [
    { title: 'slow', desc: 'slow', feeRate: 1 },
    { title: 'avg', desc: 'avg', feeRate: 2 },
    { title: 'fast', desc: 'fast', feeRate: 3 }
  ]
};
const CUSTOM_FEE_OPTION = 3;
// The form as fillSendForm leaves it.
const FILLED_FORM = {
  toInfo: { address: RECIPIENT },
  inputAmount: '0.5',
  enableRBF: false,
  memo: 'rent'
};

function account(name: string, index: number) {
  return {
    type: KeyringType.HdKeyring,
    address: `qb1z${name}`,
    brandName: 'Qbit',
    alianName: name,
    displayBrandName: 'Qbit',
    index,
    balance: 0,
    pubkey: `pubkey-${name}`,
    key: `key-${name}`,
    flag: 0
  };
}
const FIRST_ACCOUNT = account('firstaccount', 0);
const SECOND_ACCOUNT = account('secondaccount', 1);

// The background, as the page's wallet controller reaches it.
function createBackground() {
  const state = {
    unlocked: true,
    account: FIRST_ACCOUNT,
    chainType: ChainType.QBIT_MAINNET,
    enableRBF: true
  };
  const keyring = () => ({
    key: 'keyring-1',
    index: 0,
    type: KeyringType.HdKeyring,
    addressType: AddressType.P2TR,
    accounts: [FIRST_ACCOUNT, SECOND_ACCOUNT],
    alianName: 'Wallet 1',
    hdPath: ''
  });
  const wallet = {
    hasVault: vi.fn(async () => true),
    isUnlocked: vi.fn(async () => state.unlocked),
    getCurrentAccount: vi.fn(async () => state.account),
    getAccounts: vi.fn(async () => [FIRST_ACCOUNT, SECOND_ACCOUNT]),
    getKeyrings: vi.fn(async () => [keyring()]),
    getCurrentKeyring: vi.fn(async () => keyring()),
    getChainType: vi.fn(async () => state.chainType),
    getLocale: vi.fn(async () => 'en'),
    getSkippedVersion: vi.fn(async () => ''),
    getAutoLockTimeId: vi.fn(async () => 0),
    getDeveloperMode: vi.fn(async () => false),
    getWalletConfig: vi.fn(async () => ({})),
    getAddressSummary: vi.fn(async () => ({})),
    getAddressBalanceV2: vi.fn(async () => ({
      chainType: state.chainType,
      availableBalance: 0,
      unavailableBalance: 0,
      totalBalance: 0
    })),
    getBiometricUnlockStatus: vi.fn(async () => ({ enrolled: false })),
    getBiometricUnlockRecord: vi.fn(async () => ({
      version: 1 as const,
      credentialId: 'AAAA',
      prfSalt: 'AAAA',
      wrappedPassword: 'AAAA',
      iv: 'AAAA',
      createdAt: 0
    })),
    // An unlock is broadcast to every page, this one too, before it returns.
    unlock: vi.fn(async () => {
      state.unlocked = true;
      uiEventBus.emit(BUS_METHODS.UNLOCKED);
    }),
    resolveUnlockApproval: vi.fn(async () => false),
    getApproval: vi.fn(async () => undefined),
    getEnableRBF: vi.fn(async () => state.enableRBF),
    setEnableRBF: vi.fn(async (enableRBF: boolean) => {
      state.enableRBF = enableRBF;
    }),
    getQbitUtxoSnapshot: vi.fn(async () => ({ address: state.account.address, chain: state.chainType, utxos: [] })),
    abandonQbitUtxoSnapshot: vi.fn(async () => undefined),
    getFeeSummary: vi.fn(async () => FEE_SUMMARY),
    // The send screen follows the account's send plan; this account has none.
    getQbitSendPlan: vi.fn(async () => null),
    getLowFeeSummary: vi.fn(async () => FEE_SUMMARY)
  };
  return { state, wallet };
}

let background: ReturnType<typeof createBackground>;
let store: ReturnType<typeof createAppStore>;
// Every route the page shows, in order.
let shownRoutes: string[];
const noteRoute = () => {
  shownRoutes.push(window.location.hash);
};
let hidden: boolean;

function renderWallet() {
  return render(
    <Provider store={store}>
      <WalletProvider wallet={background.wallet as never}>
        <AccountUpdater />
        <Main />
      </WalletProvider>
    </Provider>
  );
}

async function openSendForm() {
  fireEvent.click(await screen.findByTestId('send-button'));
  await screen.findByTestId('recipient-address-input');
}

const fieldValue = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;

async function fillSendForm() {
  fireEvent.change(screen.getByTestId('recipient-address-input'), { target: { value: RECIPIENT } });
  fireEvent.change(screen.getByTestId('transfer-amount-input'), { target: { value: '0.5' } });
  fireEvent.click(screen.getByTestId('advanced-toggle'));
  fireEvent.change(screen.getByTestId('memo-input'), { target: { value: 'rent' } });
  fireEvent.click(screen.getByTestId('rbf-checkbox-input'));
  fireEvent.click(await screen.findByTestId(`fee-rate-option-${CUSTOM_FEE_OPTION}`));
  fireEvent.change(await screen.findByPlaceholderText('bits/vB'), { target: { value: '3.5' } });
  // The low-fee flag has no control on the form; it is kept like the rest.
  act(() => {
    store.dispatch(uiActions.updateFeeRateBar({ enableLowFeeRate: true }));
  });
  await waitFor(() => expect(store.getState().ui.uiTxCreateScreen).toEqual(FILLED_FORM));
}

async function expectFilledSendForm() {
  await screen.findByTestId('recipient-address-input');
  expect(fieldValue('recipient-address-input')).toBe(RECIPIENT);
  expect(fieldValue('transfer-amount-input')).toBe('0.5');
  expect(fieldValue('memo-input')).toBe('rent');
  expect((screen.getByTestId('rbf-checkbox-input') as HTMLInputElement).checked).toBe(false);
  const customOption = await screen.findByTestId(`fee-rate-option-${CUSTOM_FEE_OPTION}`);
  expect(customOption.getAttribute('data-selected')).toBe('true');
  expect((screen.getByPlaceholderText('bits/vB') as HTMLInputElement).value).toBe('3.5');
  expect(store.getState().ui.feeRateBar).toMatchObject({
    feeOptionIndex: CUSTOM_FEE_OPTION,
    feeRateInputVal: '3.5',
    showCustomInput: true,
    enableLowFeeRate: true
  });
}

function expectEmptySendFormState() {
  expect(store.getState().ui.uiTxCreateScreen).toEqual({
    toInfo: { address: '' },
    inputAmount: '',
    enableRBF: true,
    memo: ''
  });
  expect(store.getState().ui.feeRateBar).toMatchObject({
    feeOptionIndex: 1,
    feeRateInputVal: '',
    showCustomInput: false,
    enableLowFeeRate: false
  });
}

// The background locks: every page hears it.
async function lock() {
  await act(async () => {
    background.state.unlocked = false;
    uiEventBus.emit(BUS_METHODS.LOCKED);
  });
  await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
  await screen.findByTestId('unlock-password-input');
}

async function unlockHere() {
  fireEvent.change(screen.getByTestId('unlock-password-input'), { target: { value: 'password' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('unlock-button'));
  });
}

async function unlockInAnotherWindow() {
  await act(async () => {
    background.state.unlocked = true;
    uiEventBus.emit(BUS_METHODS.UNLOCKED);
  });
}

async function selectAccountInAnotherWindow(selected: typeof FIRST_ACCOUNT) {
  await act(async () => {
    background.state.account = selected;
    uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, selected);
  });
}

async function switchAccountInAnotherWindow() {
  await selectAccountInAnotherWindow(SECOND_ACCOUNT);
}

async function selectNetworkInAnotherWindow(chainType: ChainType) {
  await act(async () => {
    background.state.chainType = chainType;
    uiEventBus.emit(BUS_METHODS.CHAIN_CHANGED, { type: chainType });
  });
}

async function showPage() {
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const homeVisitsSince = (before: number) => visits.home - before;

const pause = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actEnvironment: boolean | undefined;

function prepare() {
  // The background's answers land when they land, as they do in the page:
  // React is not told to expect every update inside act().
  actEnvironment = (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = false;
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  localStorage.clear();
  shownRoutes = [];
  window.addEventListener('hashchange', noteRoute);
  background = createBackground();
}

// The page loads at `route`, with whatever localStorage holds from before.
function loadPageAt(route: string) {
  window.history.replaceState(null, '', `/popup.html#${route}`);
  store = createAppStore();
  renderWallet();
}

function tearDown() {
  cleanup();
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  window.removeEventListener('hashchange', noteRoute);
  delete (document as { hidden?: boolean }).hidden;
  forgetInterruptedSendForm();
}

describe('unlocking returns to the send form a lock interrupted', () => {
  beforeEach(async () => {
    prepare();
    loadPageAt('/main');
    await screen.findByTestId('home-screen');
    await openSendForm();
  });

  afterEach(tearDown);

  it('shows the send form as it was after this screen unlocks', async () => {
    await fillSendForm();
    await lock();
    const homeVisits = visits.home;

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
    expect(homeVisitsSince(homeVisits)).toBe(0);
    expect(getInterruptedSendForm()).toBeUndefined();
  });

  it('shows the send form as it was after another window unlocks', async () => {
    await fillSendForm();
    await lock();
    const homeVisits = visits.home;

    await unlockInAnotherWindow();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
    expect(homeVisitsSince(homeVisits)).toBe(0);
  });

  it('reads the outputs and the fee quote afresh and keeps the fee choice', async () => {
    await fillSendForm();
    const outputReads = background.wallet.getQbitUtxoSnapshot.mock.calls.length;
    const quoteReads = background.wallet.getFeeSummary.mock.calls.length;
    await lock();

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await waitFor(() => expect(background.wallet.getQbitUtxoSnapshot.mock.calls.length).toBe(outputReads + 1));
    await waitFor(() => expect(background.wallet.getFeeSummary.mock.calls.length).toBe(quoteReads + 1));
    await expectFilledSendForm();
  });

  it('goes Home with Back from the returned send form', async () => {
    await fillSendForm();
    await lock();
    await unlockHere();
    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await screen.findByTestId('recipient-address-input');

    fireEvent.click(screen.getByTestId('header-back-button'));

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    await screen.findByTestId('home-screen');
  });

  it.each([
    [
      'the account changed',
      async () => {
        await switchAccountInAnotherWindow();
      }
    ],
    [
      'the network changed',
      async () => {
        await act(async () => {
          background.state.chainType = ChainType.QBIT_TESTNET4;
          uiEventBus.emit(BUS_METHODS.CHAIN_CHANGED, { type: ChainType.QBIT_TESTNET4 });
        });
      }
    ],
    [
      'the network could not be read',
      async () => {
        // Errors reach the page over the port as plain objects.
        background.wallet.getChainType.mockRejectedValueOnce({ message: 'port closed', stack: '' });
      }
    ]
  ])('goes Home with an empty send form when %s', async (_change, change) => {
    await fillSendForm();
    await lock();
    await change();

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    await screen.findByTestId('home-screen');
    expectEmptySendFormState();
    expect(getInterruptedSendForm()).toBeUndefined();
    await openSendForm();
    expect(fieldValue('recipient-address-input')).toBe('');
    expect(fieldValue('transfer-amount-input')).toBe('');
  });

  it.each([
    ['confirm', '#/wallet/tx/confirm', 'confirm-screen'],
    ['consolidation', '#/wallet/tx/consolidate', 'consolidation-screen']
  ])('goes Home after a lock on the %s screen', async (_screen, route, testId) => {
    await fillSendForm();
    await act(async () => {
      window.location.hash = route;
    });
    await screen.findByTestId(testId);
    await lock();

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    await screen.findByTestId('home-screen');
    // The form is left as it was, as before: only Send clears it.
    expect(store.getState().ui.uiTxCreateScreen.memo).toBe('rent');
  });

  it('does nothing when the wallet locks again while the reads are out, and decides afresh on the next unlock', async () => {
    await fillSendForm();
    await lock();
    let answerChainType!: (chainType: ChainType) => void;
    background.wallet.getChainType.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerChainType = resolve;
        })
    );
    const outputReads = background.wallet.getQbitUtxoSnapshot.mock.calls.length;

    await unlockInAnotherWindow();
    await waitFor(() => expect(answerChainType).toBeTypeOf('function'));
    await act(async () => {
      background.state.unlocked = false;
      uiEventBus.emit(BUS_METHODS.LOCKED);
    });
    const routesBefore = shownRoutes.length;
    await act(async () => {
      answerChainType(ChainType.QBIT_MAINNET);
    });

    // The earlier answer takes no route: no screen came up behind the lock.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(shownRoutes.slice(routesBefore)).toEqual([]);
    expect(window.location.hash).toBe('#/account/unlock');
    expect(background.wallet.getQbitUtxoSnapshot.mock.calls.length).toBe(outputReads);
    expect(getInterruptedSendForm()).toBeDefined();

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
  });

  it('waits until a hidden page is shown, after another window unlocked and switched the account', async () => {
    await fillSendForm();
    await lock();
    hidden = true;
    const chainReads = background.wallet.getChainType.mock.calls.length;

    await unlockInAnotherWindow();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(window.location.hash).toBe('#/account/unlock');
    expect(background.wallet.getChainType.mock.calls.length).toBe(chainReads);

    await switchAccountInAnotherWindow();
    await showPage();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    expectEmptySendFormState();
  });

  it('waits until a hidden page is shown, after another window unlocked during its Touch ID prompt and switched the account', async () => {
    background.wallet.getBiometricUnlockStatus.mockResolvedValue({ enrolled: true });
    await fillSendForm();
    const prompt = touchIdPrompts.length;
    await lock();
    // The unlock screen opens the prompt by itself while the page is shown;
    // the prompt stays open after the page is hidden.
    await waitFor(() => expect(touchIdPrompts.length).toBe(prompt + 1));
    hidden = true;
    const chainReads = background.wallet.getChainType.mock.calls.length;

    await unlockInAnotherWindow();
    await pause(50);
    expect(window.location.hash).toBe('#/account/unlock');
    expect(background.wallet.getChainType.mock.calls.length).toBe(chainReads);

    await switchAccountInAnotherWindow();
    await showPage();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    await screen.findByTestId('home-screen');
    expectEmptySendFormState();

    // The prompt ends later, unanswered: the page stays Home.
    const routesBefore = shownRoutes.length;
    await act(async () => {
      touchIdPrompts[prompt]?.end(
        new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
      );
    });
    await pause(50);
    expect(shownRoutes.slice(routesBefore)).toEqual([]);
    expect(window.location.hash).toBe('#/main');
  });

  it("returns to the send form after this screen's unlock without waiting for a page hidden meanwhile to be shown", async () => {
    await fillSendForm();
    await lock();
    // Hidden after the password was sent, before the unlock lands.
    hidden = true;

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
  });

  it("still waits for a hidden page to be shown when this screen's unlock is routed after a lock and another window's unlock", async () => {
    await fillSendForm();
    await lock();
    hidden = true;
    // This screen's unlock lands; what follows it waits on the background.
    let answerHasVault!: (hasVault: boolean) => void;
    background.wallet.hasVault.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answerHasVault = resolve;
        })
    );
    const chainReads = background.wallet.getChainType.mock.calls.length;
    await unlockHere();
    await waitFor(() => expect(answerHasVault).toBeTypeOf('function'));
    // Meanwhile the wallet locks, and another window unlocks it.
    await act(async () => {
      background.state.unlocked = false;
      uiEventBus.emit(BUS_METHODS.LOCKED);
    });
    await unlockInAnotherWindow();

    await act(async () => {
      answerHasVault(true);
    });
    await pause(50);
    expect(window.location.hash).toBe('#/account/unlock');
    expect(background.wallet.getChainType.mock.calls.length).toBe(chainReads);

    await switchAccountInAnotherWindow();
    await showPage();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    expectEmptySendFormState();
  });

  it('returns a hidden page to the send form once it is shown, after another window unlocked', async () => {
    await fillSendForm();
    await lock();
    hidden = true;

    await unlockInAnotherWindow();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(window.location.hash).toBe('#/account/unlock');

    await showPage();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
  });

  describe.each([
    [
      'the account',
      async () => {
        await switchAccountInAnotherWindow();
        await selectAccountInAnotherWindow(FIRST_ACCOUNT);
      }
    ],
    [
      'the network',
      async () => {
        await selectNetworkInAnotherWindow(ChainType.QBIT_TESTNET4);
        await selectNetworkInAnotherWindow(ChainType.QBIT_MAINNET);
      }
    ]
  ])('when another window switches %s away and back before the return is decided', (_what, awayAndBack) => {
    // The store cleared the form at each switch: the page goes Home, as for
    // another account or network, not back to an emptied form.
    async function expectHomeWithAnEmptyForm() {
      await waitFor(() => expect(window.location.hash).toBe('#/main'));
      await screen.findByTestId('home-screen');
      expectEmptySendFormState();
      expect(getInterruptedSendForm()).toBeUndefined();
    }

    it('goes Home from a page that was hidden, once it is shown', async () => {
      await fillSendForm();
      await lock();
      hidden = true;
      await unlockInAnotherWindow();
      await pause(50);
      expect(window.location.hash).toBe('#/account/unlock');

      await awayAndBack();
      await showPage();

      await expectHomeWithAnEmptyForm();
    });

    it('goes Home from a page that was shown, while its reads were out', async () => {
      await fillSendForm();
      await lock();
      let answerChainType!: (chainType: ChainType) => void;
      background.wallet.getChainType.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerChainType = resolve;
          })
      );
      await unlockInAnotherWindow();
      await waitFor(() => expect(answerChainType).toBeTypeOf('function'));

      await awayAndBack();
      // The background has the account and network of the lock again.
      await act(async () => {
        answerChainType(ChainType.QBIT_MAINNET);
      });

      await expectHomeWithAnEmptyForm();
    });
  });

  it('returns a hidden page to the send form as it was when another window selects the same account again', async () => {
    await fillSendForm();
    await lock();
    hidden = true;
    await unlockInAnotherWindow();
    await pause(50);

    // A read of the same account: no switch, so the form is not cleared.
    await selectAccountInAnotherWindow(FIRST_ACCOUNT);
    await showPage();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
  });

  it('goes Home after a lock on another screen that followed a lock on the send form', async () => {
    await fillSendForm();
    await lock();
    expect(getInterruptedSendForm()).toBeDefined();
    // Elsewhere while locked, by the address bar.
    await act(async () => {
      window.location.hash = '#/settings';
    });
    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
    expect(shownRoutes).toContain('#/settings');
    expect(getInterruptedSendForm()).toBeUndefined();

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
  });

  it('goes Home after Back from the unlock screen to the send form while locked', async () => {
    await fillSendForm();
    await lock();
    const routesBefore = shownRoutes.length;

    // The form comes back locked and sends the page to the unlock screen again.
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(shownRoutes.slice(routesBefore)).toEqual(['#/wallet/tx/create', '#/account/unlock']));
    await screen.findByTestId('unlock-password-input');
    expect(getInterruptedSendForm()).toBeUndefined();

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    await screen.findByTestId('home-screen');
    // The form is left as it was, as before: only Send clears it.
    expect(store.getState().ui.uiTxCreateScreen).toEqual(FILLED_FORM);
  });

  it('goes Home once, keeping the form, when the step back to the send form goes nowhere', async () => {
    await fillSendForm();
    await lock();
    const homeVisits = visits.home;
    // No earlier entry to go to.
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    try {
      await unlockHere();

      await waitFor(() => expect(back).toHaveBeenCalledOnce());
      expect(window.location.hash).toBe('#/account/unlock');
      await waitFor(() => expect(window.location.hash).toBe('#/main'), {
        timeout: SEND_FORM_RETURN_FALLBACK_MS + 2000
      });
      await screen.findByTestId('home-screen');
      await pause(SEND_FORM_RETURN_FALLBACK_MS + 200);

      expect(back).toHaveBeenCalledOnce();
    } finally {
      back.mockRestore();
    }
    expect(homeVisitsSince(homeVisits)).toBe(1);
    expect(window.location.hash).toBe('#/main');
    // The account and network matched: the form is kept.
    expect(store.getState().ui.uiTxCreateScreen).toEqual(FILLED_FORM);
    // Waits out the fallback in real time, twice.
  }, 20_000);

  it('stays on the send form after a step back that worked', async () => {
    await fillSendForm();
    await lock();
    const homeVisits = visits.home;

    await unlockHere();
    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await pause(SEND_FORM_RETURN_FALLBACK_MS + 300);

    expect(window.location.hash).toBe('#/wallet/tx/create');
    expect(homeVisitsSince(homeVisits)).toBe(0);
    await expectFilledSendForm();
    // Waits out the fallback in real time.
  }, 20_000);

  it('goes Home after a lock on Home, as before', async () => {
    await act(async () => {
      window.history.back();
    });
    await screen.findByTestId('home-screen');
    await lock();

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    expect(getInterruptedSendForm()).toBeUndefined();
  });
});

describe('a send form the page never showed unlocked', () => {
  // A draft an earlier build saved: builds before 1.0.9 kept the whole ui
  // slice, the send form in it, in localStorage, and the replace-by-fee choice
  // in the background. This build loads only the display preferences from it.
  function saveDraft() {
    background.state.enableRBF = false;
    localStorage.setItem(
      'redux_localstorage_simple_ui',
      JSON.stringify({
        uiTxCreateScreen: FILLED_FORM,
        feeRateBar: { feeOptionIndex: CUSTOM_FEE_OPTION, feeRateInputVal: '3.5', showCustomInput: true }
      })
    );
  }

  beforeEach(() => {
    prepare();
    saveDraft();
  });

  afterEach(tearDown);

  // Nothing of that draft is in the page: no recipient, amount, memo or fee
  // choice in its store, and no recipient in localStorage. The form that
  // mounted reads replace-by-fee from the background, which is not the draft.
  function expectNoDraft() {
    expect(store.getState().ui.uiTxCreateScreen).toMatchObject({ toInfo: { address: '' }, inputAmount: '', memo: '' });
    expect(store.getState().ui.feeRateBar).toMatchObject({
      feeOptionIndex: 1,
      feeRateInputVal: '',
      showCustomInput: false
    });
    expect(Object.values({ ...localStorage }).join('\n')).not.toContain(RECIPIENT);
  }

  it('goes Home after unlocking a page that loaded locked on the send form, reading nothing for a return', async () => {
    background.state.unlocked = false;
    loadPageAt('/wallet/tx/create');
    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
    // The page starts with an empty form: the draft is not loaded.
    expectNoDraft();
    const formAtLoad = store.getState().ui.uiTxCreateScreen;
    const chainReads = background.wallet.getChainType.mock.calls.length;
    const homeVisits = visits.home;

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    await screen.findByTestId('home-screen');
    expect(homeVisitsSince(homeVisits)).toBeGreaterThan(0);
    expect(background.wallet.getChainType.mock.calls.length).toBe(chainReads);
    // Untouched, as before: only Send clears it. Nor does the draft come back.
    expect(store.getState().ui.uiTxCreateScreen).toEqual(formAtLoad);
    expectNoDraft();
  });

  // The page does not show its routes before it knows whether the wallet is
  // unlocked (PageStartup reads that with the rest as it starts), so it never
  // mounts the form locked on the way: no unlock screen in between, and no
  // return remembered. The form it then shows unlocked is one it showed.
  it('shows the send form only once it knows the wallet is unlocked, for a page that loads on it', async () => {
    let answerIsUnlocked!: (unlocked: boolean) => void;
    background.wallet.isUnlocked.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answerIsUnlocked = resolve;
        })
    );
    loadPageAt('/wallet/tx/create');
    await waitFor(() => expect(background.wallet.isUnlocked).toHaveBeenCalled());
    expect(screen.queryByTestId('unlock-password-input')).toBeNull();
    expect(screen.queryByTestId('recipient-address-input')).toBeNull();
    expectNoDraft();
    const formAtLoad = store.getState().ui.uiTxCreateScreen;
    const chainReads = background.wallet.getChainType.mock.calls.length;
    const homeVisits = visits.home;

    await act(async () => {
      answerIsUnlocked(true);
    });

    await screen.findByTestId('recipient-address-input');
    expect(window.location.hash).toBe('#/wallet/tx/create');
    expect(screen.queryByTestId('unlock-password-input')).toBeNull();
    expect(homeVisitsSince(homeVisits)).toBe(0);
    expect(getInterruptedSendForm()).toBeUndefined();
    expect(background.wallet.getChainType.mock.calls.length).toBe(chainReads);
    // Shown unlocked, the form takes the replace-by-fee choice the background
    // keeps for the next send, and nothing else: no draft comes back.
    expect(store.getState().ui.uiTxCreateScreen).toEqual({ ...formAtLoad, enableRBF: false });
    expectNoDraft();
  });
});

// The return with the page's own checks in place, as the UI entry wires them:
// an unlock reaches the page only once the id of the wallet set up has been
// compared with the one it shows, and a reset, or the background refusing the
// page as out of date, drops the form with the rest of the page's memory.
describe('the send form a lock interrupted, with the page’s wallet checks in place', () => {
  let checks: ReturnType<typeof installPageChecks>;
  const walletIdRead = vi.fn(async (): Promise<string | null> => 'wallet-1');

  beforeEach(async () => {
    prepare();
    walletIdRead.mockImplementation(async () => 'wallet-1');
    Object.assign(background.wallet, { isBooted: vi.fn(async () => true), getWalletId: walletIdRead });
    // This screen's own unlock: announced to every page first, and answered
    // once the check has settled, as the wallet proxy answers it.
    background.wallet.unlock.mockImplementation(async () => {
      background.state.unlocked = true;
      checks.broadcast(BUS_METHODS.UNLOCKED);
      await checks.afterUnlock();
    });
    loadPageAt('/main');
    checks = installPageChecks(store, background.wallet as never);
    await screen.findByTestId('home-screen');
    await waitFor(() => expect(getShownWalletId()).toBe('wallet-1'));
    await openSendForm();
    await fillSendForm();
    await act(async () => {
      background.state.unlocked = false;
      checks.broadcast(BUS_METHODS.LOCKED);
    });
    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
    expect(getInterruptedSendForm()).toBeDefined();
    // Locked, the draft is in the page's memory only: nothing of it is saved.
    expect(store.getState().ui.uiTxCreateScreen).toEqual(FILLED_FORM);
    expect(Object.values({ ...localStorage }).join('\n')).not.toContain(RECIPIENT);
  });

  afterEach(() => {
    checks.uninstall();
    forgetShownWalletId();
    tearDown();
  });

  it('returns to it after this screen’s unlock, once the id of the wallet set up is checked', async () => {
    const idReads = walletIdRead.mock.calls.length;

    await unlockHere();

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
    expect(walletIdRead.mock.calls.length).toBeGreaterThan(idReads);
  });

  it('returns to it after another window’s unlock, once the id is checked', async () => {
    const idReads = walletIdRead.mock.calls.length;

    await act(async () => {
      background.state.unlocked = true;
      checks.broadcast(BUS_METHODS.UNLOCKED);
    });

    await waitFor(() => expect(window.location.hash).toBe('#/wallet/tx/create'));
    await expectFilledSendForm();
    expect(walletIdRead.mock.calls.length).toBeGreaterThan(idReads);
  });

  it('leaves no form to return to after a reset', async () => {
    await act(async () => {
      checks.broadcast(BUS_METHODS.WALLET_RESET);
    });

    expect(checks.reload).toHaveBeenCalledTimes(1);
    expect(getInterruptedSendForm()).toBeUndefined();
    expectEmptySendFormState();
    expect(store.getState().ui.sendFormScope).toBeNull();
    expect(Object.values({ ...localStorage }).join('\n')).not.toContain(RECIPIENT);
  });

  it('leaves no form to return to when the background refuses the page as out of date', async () => {
    await act(async () => {
      reopenOutOfDatePage();
    });

    expect(checks.reloadOnBoot).toHaveBeenCalledTimes(1);
    expect(getInterruptedSendForm()).toBeUndefined();
    expectEmptySendFormState();
    expect(store.getState().ui.sendFormScope).toBeNull();
    expect(Object.values({ ...localStorage }).join('\n')).not.toContain(RECIPIENT);
  });
});
