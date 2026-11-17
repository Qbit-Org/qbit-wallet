/**
 * An open send form when another window switches the account or the
 * network: the page's real store (the package's build), AccountUpdater and
 * send form, with its inputs, fee bar and replace-by-fee box, and the
 * background behind the wallet controller stood in for.
 */
import { type ReactNode, useState } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TxCreateScreen from '@/ui/pages/Wallet/TxCreateScreen';
import {
  P2MR_LEAF_VERSION_V1,
  bytesToHex,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript
} from '@qbit-oss/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BUS_METHODS, KeyringType } from '@qbit/wallet-shared';
import {
  accountActions,
  AccountUpdater,
  createAppStore,
  globalActions,
  I18nContext,
  NavigationContext,
  ToolsContext,
  uiActions,
  uiEventBus,
  WalletProvider
} from '@qbit/wallet-state';
import { AddressType, ChainType } from '@qbit/wallet-types';

vi.mock('@qbit/wallet-state', () => import('../../../packages/wallet-state/lib/index.mjs'));
// Layout reads the routes, which load every screen; the send form is all this needs.
vi.mock('@/ui/components/Layout', () => ({
  Layout: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}));
vi.mock('@/ui/components/ContactsModal', () => ({ ContactsModal: () => null }));

const NETWORKS = { [ChainType.QBIT_MAINNET]: 'mainnet', [ChainType.QBIT_TESTNET4]: 'testnet4' } as const;
type Network = keyof typeof NETWORKS;

function p2mrAccount(pubkeyHex: string, chainType: Network) {
  const pubkey = hexToBytes(pubkeyHex);
  const leafScript = singleKeyLeafScript(pubkey);
  const scriptPubKey = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript));
  return {
    type: KeyringType.QbitHdKeyring,
    address: p2mrAddressFromPubkey(pubkey, NETWORKS[chainType]),
    brandName: 'Qbit',
    alianName: `Account ${pubkeyHex.slice(0, 2)}`,
    displayBrandName: 'Qbit',
    index: 0,
    balance: 0,
    pubkey: pubkeyHex,
    key: `account-${pubkeyHex.slice(0, 2)}`,
    flag: 0,
    p2mr: {
      pubkey: pubkeyHex,
      path: "m/87'/0'/0'/0/0",
      scriptPubKey: bytesToHex(scriptPubKey),
      leafScript: bytesToHex(leafScript),
      addresses: {
        mainnet: p2mrAddressFromPubkey(pubkey, 'mainnet'),
        testnet4: p2mrAddressFromPubkey(pubkey, 'testnet4'),
        signet: p2mrAddressFromPubkey(pubkey, 'signet'),
        regtest: p2mrAddressFromPubkey(pubkey, 'regtest')
      },
      hkdf: { account: 0, change: 0, index: 0 },
      signatureCounter: {
        count: 0,
        limit: 1073741824,
        remaining: 1073741824,
        state: 'normal' as const,
        provenance: 'local' as const
      }
    }
  };
}

type Account = ReturnType<typeof p2mrAccount>;

const FIRST = p2mrAccount('11'.repeat(32), ChainType.QBIT_MAINNET);
const SECOND = p2mrAccount('22'.repeat(32), ChainType.QBIT_MAINNET);
const FIRST_ON_TESTNET = p2mrAccount('11'.repeat(32), ChainType.QBIT_TESTNET4);
const RECIPIENT = p2mrAddressFromPubkey(hexToBytes('33'.repeat(32)), 'mainnet');
const FEE_SUMMARY = {
  list: [
    { title: 'slow', desc: 'slow', feeRate: 1 },
    { title: 'avg', desc: 'avg', feeRate: 2 },
    { title: 'fast', desc: 'fast', feeRate: 3 }
  ]
};
const AVG_FEE_OPTION = 1;
const CUSTOM_FEE_OPTION = 3;

// The background, as the page's wallet controller reaches it.
function createBackground() {
  const state = { account: FIRST as Account, chainType: ChainType.QBIT_MAINNET as Network, enableRBF: true };
  const keyring = () => ({
    key: 'keyring-1',
    index: 0,
    type: KeyringType.QbitHdKeyring,
    addressType: AddressType.P2MR,
    accounts: [state.account],
    alianName: 'Wallet 1',
    hdPath: ''
  });
  const wallet = {
    getCurrentAccount: vi.fn(async () => state.account),
    getAccounts: vi.fn(async () => [state.account]),
    getKeyrings: vi.fn(async () => [keyring()]),
    getCurrentKeyring: vi.fn(async () => keyring()),
    getWalletConfig: vi.fn(async () => ({})),
    getAddressBalanceV2: vi.fn(async () => ({
      chainType: state.chainType,
      availableBalance: 10_000_000,
      unavailableBalance: 0,
      totalBalance: 10_000_000
    })),
    getEnableRBF: vi.fn(async () => state.enableRBF),
    setEnableRBF: vi.fn(async (enableRBF: boolean) => {
      state.enableRBF = enableRBF;
    }),
    getQbitUtxoSnapshot: vi.fn(async () => ({
      address: state.account.address,
      chain: state.chainType,
      utxos: [
        {
          txid: state.account.pubkey.slice(0, 2).repeat(32),
          vout: 0,
          satoshis: 10_000_000,
          scriptPk: state.account.p2mr.scriptPubKey,
          pubkey: state.account.pubkey,
          addressType: AddressType.P2MR
        }
      ]
    })),
    abandonQbitUtxoSnapshot: vi.fn(async () => undefined),
    getFeeSummary: vi.fn(async () => FEE_SUMMARY),
    // The send screen follows the account's send plan; this account has none.
    getQbitSendPlan: vi.fn(async () => null),
    getLowFeeSummary: vi.fn(async () => FEE_SUMMARY),
    createSendQbitPsbt: vi.fn(async () => ({ psbtHex: 'prepared' })),
    createSendAllQbitPsbt: vi.fn(async () => ({ psbtHex: 'prepared' })),
    createSendQbitOffsetPsbt: vi.fn(async () => ({ psbtHex: 'prepared' }))
  };
  return { state, wallet };
}

let background: ReturnType<typeof createBackground>;
let store: ReturnType<typeof createAppStore>;
const navigation = { navigate: vi.fn(), replace: vi.fn(), getRouteState: vi.fn(() => ({})) };
const tools = { showLoading: vi.fn(), toast: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn() };
const i18n = {
  t: (key: string) => key,
  locale: 'en',
  supportedLocales: [],
  localeNames: {},
  changeLocale: async () => undefined,
  isSpecialLocale: false
};

// Shows or leaves the send form, as navigating to and from it does; the page
// itself, with AccountUpdater, stays.
let showSendForm: (shown: boolean) => void = () => undefined;

function Page() {
  const [shown, setShown] = useState(true);
  showSendForm = setShown;
  return (
    <>
      <AccountUpdater />
      {shown ? <TxCreateScreen /> : null}
    </>
  );
}

function renderSendForm() {
  return render(
    <Provider store={store}>
      <WalletProvider wallet={background.wallet as never}>
        <NavigationContext.Provider value={navigation as never}>
          <ToolsContext.Provider value={tools as never}>
            <I18nContext.Provider value={i18n as never}>
              <Page />
            </I18nContext.Provider>
          </ToolsContext.Provider>
        </NavigationContext.Provider>
      </WalletProvider>
    </Provider>
  );
}

async function leaveAndReturn(meanwhile: () => void = () => undefined) {
  act(() => showSendForm(false));
  expect(screen.queryByTestId('recipient-address-input')).toBeNull();
  await act(async () => meanwhile());
  act(() => showSendForm(true));
  await screen.findByTestId('recipient-address-input');
}

const field = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const rbfBox = () => field('rbf-checkbox-input');
const feeOption = (index: number) => screen.getByTestId(`fee-rate-option-${index}`);

async function fillSendForm() {
  fireEvent.change(field('recipient-address-input'), { target: { value: RECIPIENT } });
  fireEvent.change(field('transfer-amount-input'), { target: { value: '0.01' } });
  fireEvent.click(screen.getByTestId('advanced-toggle'));
  fireEvent.change(field('memo-input'), { target: { value: 'rent' } });
  fireEvent.click(rbfBox());
  fireEvent.click(await screen.findByTestId(`fee-rate-option-${CUSTOM_FEE_OPTION}`));
  fireEvent.change(await screen.findByPlaceholderText('bits/vB'), { target: { value: '3.5' } });
  await waitFor(() => expect(screen.getByTestId('tx-total-spend').textContent).toMatch(/^0\.01/));
  expect(field('recipient-address-input').value).toBe(RECIPIENT);
  expect(rbfBox().checked).toBe(false);
  expect(feeOption(CUSTOM_FEE_OPTION).getAttribute('data-selected')).toBe('true');
}

/** The form as fillSendForm leaves it. */
async function expectFilledSendForm() {
  expect(field('recipient-address-input').value).toBe(RECIPIENT);
  expect(field('transfer-amount-input').value).toBe('0.01');
  expect(field('memo-input').value).toBe('rent');
  await waitFor(() => expect(rbfBox().checked).toBe(false));
  expect(feeOption(CUSTOM_FEE_OPTION).getAttribute('data-selected')).toBe('true');
  expect((screen.getByPlaceholderText('bits/vB') as HTMLInputElement).value).toBe('3.5');
  await waitFor(() => expect(screen.getByTestId('tx-total-spend').textContent).toMatch(/^0\.01/));
}

/** The form as a newly opened one shows it, with nothing left of what was typed. */
async function expectEmptySendForm() {
  expect(field('recipient-address-input').value).toBe('');
  expect(field('transfer-amount-input').value).toBe('');
  // Advanced is closed, as on a newly opened form without a memo; opened, it
  // shows the memo empty.
  expect(screen.queryByTestId('memo-input')).toBeNull();
  fireEvent.click(screen.getByTestId('advanced-toggle'));
  expect(field('memo-input').value).toBe('');
  expect(feeOption(AVG_FEE_OPTION).getAttribute('data-selected')).toBe('true');
  expect(feeOption(CUSTOM_FEE_OPTION).getAttribute('data-selected')).toBe('false');
  expect(screen.queryByPlaceholderText('bits/vB')).toBeNull();
  expect(screen.queryByTestId('tx-create-error')).toBeNull();
  expect(screen.queryByText('recipient_address_is_invalid')).toBeNull();
  expect(screen.queryByTestId('tx-spend-summary')).toBeNull();
  expect(screen.queryByTestId('tx-size-estimate')).toBeNull();
  // The saved replace-by-fee choice, which unchecking the box saved.
  await waitFor(() => expect(rbfBox().checked).toBe(false));
  // Next does nothing: there is no send to prepare.
  fireEvent.click(screen.getByTestId('tx-next-button'));
  await act(async () => undefined);
  expect(background.wallet.createSendQbitPsbt).not.toHaveBeenCalled();
  expect(background.wallet.createSendAllQbitPsbt).not.toHaveBeenCalled();
  expect(navigation.navigate).not.toHaveBeenCalledWith('TxConfirmScreen', expect.anything());
}

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actEnvironment: boolean | undefined;

beforeEach(async () => {
  // The background's answers land when they land, as they do in the page.
  actEnvironment = (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = false;
  localStorage.clear();
  background = createBackground();
  store = createAppStore();
  // As the page starts: the account and network load before any screen shows.
  store.dispatch(accountActions.setCurrent(FIRST));
  store.dispatch(globalActions.update({ isUnlocked: true }));
  renderSendForm();
  // AccountUpdater reads the accounts again, as the page does once it is unlocked.
  await waitFor(() => expect(background.wallet.getCurrentAccount).toHaveBeenCalled());
  await screen.findByTestId('recipient-address-input');
});

afterEach(() => {
  cleanup();
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  localStorage.clear();
});

describe('an open send form when another window switches', () => {
  it('the account: shows the form as a newly opened one', async () => {
    await fillSendForm();

    await act(async () => {
      background.state.account = SECOND;
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, SECOND);
    });

    expect(store.getState().accounts.current.address).toBe(SECOND.address);
    await expectEmptySendForm();
  });

  it('the network: shows the form as a newly opened one', async () => {
    await fillSendForm();

    await act(async () => {
      background.state.chainType = ChainType.QBIT_TESTNET4;
      background.state.account = FIRST_ON_TESTNET;
      uiEventBus.emit(BUS_METHODS.CHAIN_CHANGED, { type: ChainType.QBIT_TESTNET4 });
    });
    await waitFor(() => expect(store.getState().accounts.current.address).toBe(FIRST_ON_TESTNET.address));

    await expectEmptySendForm();
  });

  it('the account while an address is half typed: the text and its error go too', async () => {
    const typed = RECIPIENT.slice(0, 20);
    fireEvent.change(field('recipient-address-input'), { target: { value: typed } });
    fireEvent.blur(field('recipient-address-input'));
    expect(field('recipient-address-input').value).toBe(typed);
    expect(screen.getByText('recipient_address_is_invalid')).toBeTruthy();
    // The store holds no address for text that is not one.
    expect(store.getState().ui.uiTxCreateScreen.toInfo.address).toBe('');

    await act(async () => {
      background.state.account = SECOND;
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, SECOND);
    });

    expect(field('recipient-address-input').value).toBe('');
    expect(screen.queryByText('recipient_address_is_invalid')).toBeNull();
  });

  it('to the same account: keeps everything shown', async () => {
    await fillSendForm();

    await act(async () => {
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, { ...FIRST, flag: 1 });
    });

    await expectFilledSendForm();
  });
});

// Another window selects `account` on `chainType`, and this page takes it in.
async function switchInAnotherWindow(account: Account, chainType: Network) {
  const networkChanges = background.state.chainType !== chainType;
  background.state.account = account;
  background.state.chainType = chainType;
  await act(async () => {
    if (networkChanges) uiEventBus.emit(BUS_METHODS.CHAIN_CHANGED, { type: chainType });
    else uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, account);
  });
  await waitFor(() => expect(store.getState().accounts.current.address).toBe(account.address));
}

describe('an open send form when another window switches away and back', () => {
  it('to the first account: Advanced stays closed and the form empty', async () => {
    await fillSendForm();

    await switchInAnotherWindow(SECOND, ChainType.QBIT_MAINNET);
    await switchInAnotherWindow(FIRST, ChainType.QBIT_MAINNET);

    await expectEmptySendForm();
  });

  it('to the first network: Advanced stays closed and the form empty', async () => {
    await fillSendForm();

    await switchInAnotherWindow(FIRST_ON_TESTNET, ChainType.QBIT_TESTNET4);
    await switchInAnotherWindow(FIRST, ChainType.QBIT_MAINNET);

    await expectEmptySendForm();
  });

  it('to the first account within one update: the address input starts again too', async () => {
    const typed = RECIPIENT.slice(0, 20);
    fireEvent.change(field('recipient-address-input'), { target: { value: typed } });
    fireEvent.blur(field('recipient-address-input'));
    expect(screen.getByText('recipient_address_is_invalid')).toBeTruthy();

    // Away and back before the screen renders again.
    act(() => {
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, SECOND);
      uiEventBus.emit(BUS_METHODS.ACCOUNTS_CHANGED, FIRST);
    });

    expect(store.getState().accounts.current.address).toBe(FIRST.address);
    expect(field('recipient-address-input').value).toBe('');
    expect(screen.queryByText('recipient_address_is_invalid')).toBeNull();
  });
});

describe('the send form on the usual path', () => {
  it('shows what was entered again on Back from the confirm step', async () => {
    await fillSendForm();

    await leaveAndReturn();

    await expectFilledSendForm();
  });

  it('keeps what was entered through a lock and an unlock, for a return to the form', async () => {
    await fillSendForm();

    await leaveAndReturn(() => {
      uiEventBus.emit(BUS_METHODS.LOCKED);
      uiEventBus.emit(BUS_METHODS.UNLOCKED);
    });

    expect(store.getState().global.isUnlocked).toBe(true);
    await expectFilledSendForm();
  });

  it('opens empty from Send on Home', async () => {
    await fillSendForm();

    // Home's Send clears the form before it opens it.
    await leaveAndReturn(() => {
      store.dispatch(uiActions.resetTxCreateScreen());
      store.dispatch(uiActions.resetFeeRateBar());
    });

    await expectEmptySendForm();
  });
});
