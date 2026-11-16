/**
 * A wallet page goes to the unlock screen when the wallet locks, also when it
 * loaded before the wallet existed (#198): the page's real store, updater,
 * router (MainRoute, with its routes and its read of the vault as the page
 * loads), Layout and screens, with the background behind the wallet
 * controller stood in for.
 */
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Main from '@/ui/pages/MainRoute';
import { forgetShownWalletId, getShownWalletId } from '@/ui/utils/walletReset';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BUS_METHODS, KeyringType } from '@qbit/wallet-shared';
import { AccountUpdater, createAppStore, uiEventBus, WalletProvider } from '@qbit/wallet-state';
import { AddressType, ChainType } from '@qbit/wallet-types';

import { installPageChecks } from './support/pageChecks';

// The extension's test config takes @qbit/wallet-state from its sources, whose
// own `src/...` imports only that package's config resolves. The page's real
// store, hooks and updater come from the package's build instead, which the
// checks build before they test.
vi.mock('@qbit/wallet-state', () => import('../../../packages/wallet-state/lib/index.mjs'));
// The home screen, which only an unlock below goes to, as a stand-in: its own
// reads of the browser's tabs take no part here.
vi.mock('@/ui/pages/Main/WalletTabScreen', () => ({ default: () => <span data-testid="home-screen" /> }));

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

const ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw';
const ACCOUNT = {
  type: KeyringType.QbitHdKeyring,
  address: ADDRESS,
  brandName: 'Qbit',
  alianName: 'Account 1',
  displayBrandName: 'Qbit',
  index: 0,
  balance: 0,
  pubkey: 'pubkey-1',
  key: 'keyring_0#0',
  flag: 0,
  p2mr: {
    pubkey: 'pubkey-1',
    path: "m/87'/0'/0'/0/0",
    scriptPubKey: '5120',
    leafScript: '',
    addresses: { mainnet: ADDRESS, testnet4: ADDRESS, signet: ADDRESS, regtest: ADDRESS },
    hkdf: { account: 0, change: 0, index: 0 },
    signatureCounter: {
      count: 0,
      limit: 1024,
      remaining: 1024,
      state: 'normal',
      provenance: 'local',
      knownOnChainSignatures: 0
    }
  }
};
const KEYRING = {
  key: 'keyring_0',
  index: 0,
  type: KeyringType.QbitHdKeyring,
  addressType: AddressType.P2MR,
  accounts: [ACCOUNT],
  alianName: 'Wallet 1',
  color: 'green',
  hdPath: "m/87'/0'/0'/0"
};
const FEE_SUMMARY = {
  list: [
    { title: 'slow', desc: 'slow', feeRate: 1 },
    { title: 'avg', desc: 'avg', feeRate: 2 },
    { title: 'fast', desc: 'fast', feeRate: 3 }
  ]
};

// A restore the page started, returned or failed when the test says.
type Restore = { finish: (report: unknown) => void; fail: (error: Error) => void };

// The background, as the page's wallet controller reaches it. The wallet's
// password exists, so it is unlocked; the vault exists once a wallet is saved.
function createBackground() {
  const state = { vault: false, unlocked: true, holdVaultReads: false };
  // Vault reads made while `holdVaultReads` is set, answered when the test says.
  const heldVaultReads: Array<() => void> = [];
  // Restores the page starts, returned or failed when the test says.
  const restores: Restore[] = [];
  const wallet = {
    restoreQbitKeyringWithFloors: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          restores.push({ finish: resolve, fail: reject });
        })
    ),
    hasVault: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          if (state.holdVaultReads) {
            heldVaultReads.push(() => resolve(state.vault));
          } else {
            resolve(state.vault);
          }
        })
    ),
    isBooted: vi.fn(async () => true),
    // The id of the wallet set up, which the page reads as it starts: none
    // before a wallet is saved.
    getWalletId: vi.fn(async (): Promise<string | null> => (state.vault ? 'wallet-1' : null)),
    isUnlocked: vi.fn(async () => state.unlocked),
    getCurrentAccount: vi.fn(async () => (state.vault ? ACCOUNT : null)),
    getAccounts: vi.fn(async () => (state.vault ? [ACCOUNT] : [])),
    getKeyrings: vi.fn(async () => (state.vault ? [KEYRING] : [])),
    getCurrentKeyring: vi.fn(async () => (state.vault ? KEYRING : null)),
    getChainType: vi.fn(async () => ChainType.QBIT_MAINNET),
    getLocale: vi.fn(async () => 'en'),
    getSkippedVersion: vi.fn(async () => ''),
    getAutoLockTimeId: vi.fn(async () => 0),
    getDeveloperMode: vi.fn(async () => false),
    getWalletConfig: vi.fn(async () => ({})),
    getBiometricUnlockStatus: vi.fn(async () => ({ enrolled: false })),
    getApproval: vi.fn(async () => undefined),
    getEnableRBF: vi.fn(async () => true),
    getFeeSummary: vi.fn(async () => FEE_SUMMARY),
    getLowFeeSummary: vi.fn(async () => FEE_SUMMARY)
  };
  // Any other call stays unanswered, as on a slow background: the screens
  // wait for it, and are still shown.
  const background = new Proxy(wallet, {
    get: (target, key) =>
      key in target
        ? target[key as keyof typeof target]
        : key === 'then'
          ? undefined
          : () => new Promise(() => undefined)
  });
  const answerHeldVaultReads = async () => {
    await act(async () => {
      heldVaultReads.splice(0).forEach((answer) => answer());
    });
  };
  return { state, wallet, background, answerHeldVaultReads, restores };
}

let background: ReturnType<typeof createBackground>;
let store: ReturnType<typeof createAppStore>;

type ActEnvironment = { IS_REACT_ACT_ENVIRONMENT?: boolean };
let actEnvironment: boolean | undefined;

beforeEach(() => {
  // The background's answers land when they land, as they do in the page:
  // React is not told to expect every update inside act().
  actEnvironment = (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = false;
  background = createBackground();
});

afterEach(() => {
  cleanup();
  (globalThis as ActEnvironment).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
});

// The page loads at `route`.
async function loadPageAt(route: string) {
  window.history.replaceState(null, '', `/index.html#${route}`);
  store = createAppStore();
  render(
    <Provider store={store}>
      <WalletProvider wallet={background.background as never}>
        <AccountUpdater />
        <Main />
      </WalletProvider>
    </Provider>
  );
  // Its read of the vault as it loads has answered.
  await waitFor(() => expect(background.wallet.hasVault).toHaveBeenCalledTimes(1));
  await act(async () => undefined);
}

// What each route under test shows once it has loaded.
const ROUTES = [
  ['the send form', '/wallet/tx/create', 'recipient-address-input'],
  ['the receive screen', '/wallet/receive', 'receive-loading'],
  ['the settings', '/settings', 'settings_lockwallet']
] as const;

async function goTo(route: string, shownTestId: string) {
  await act(async () => {
    window.location.hash = `#${route}`;
  });
  await screen.findByTestId(shownTestId);
}

// The background tells every page what it does.
async function announce(method: string) {
  await act(async () => {
    uiEventBus.emit(method);
  });
}

// A wallet is saved, in this page or another: the background announces it
// unlocked to every page, as it does for a wallet saved while unlocked.
async function saveWallet() {
  background.state.vault = true;
  await announce(BUS_METHODS.UNLOCKED);
}

async function lock() {
  background.state.unlocked = false;
  await announce(BUS_METHODS.LOCKED);
}

// Lets answers already given be acted on.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Waits until the page has made `count` vault reads, and for their answers to
// be acted on.
async function vaultReadsAnswered(count: number) {
  await waitFor(() => expect(background.wallet.hasVault).toHaveBeenCalledTimes(count));
  await flush();
}

describe('a page that loaded before the wallet existed', () => {
  it.each(ROUTES)('goes from %s to the unlock screen when the wallet locks', async (_name, route, shownTestId) => {
    await loadPageAt('/welcome');
    await screen.findByTestId('welcome-title');
    await saveWallet();
    await goTo(route, shownTestId);

    await lock();

    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
  });

  it('stays where it is when the wallet locks with no vault', async () => {
    await loadPageAt('/welcome');
    await screen.findByTestId('welcome-title');

    await lock();
    await vaultReadsAnswered(2);

    expect(window.location.hash).toBe('#/welcome');
    expect(screen.getByTestId('welcome-title')).toBeTruthy();
  });

  it('stays where it is when an unlock comes before the vault read answers', async () => {
    await loadPageAt('/welcome');
    await saveWallet();
    await goTo('/wallet/tx/create', 'recipient-address-input');

    background.state.holdVaultReads = true;
    await lock();
    background.state.unlocked = true;
    await announce(BUS_METHODS.UNLOCKED);
    await background.answerHeldVaultReads();
    await vaultReadsAnswered(2);

    expect(window.location.hash).toBe('#/wallet/tx/create');
    expect(screen.getByTestId('recipient-address-input')).toBeTruthy();

    // It knows of the vault now: the next lock sends it on.
    background.state.holdVaultReads = false;
    await lock();
    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
  });
});

// The same page with the page's own checks in place, as the UI entry wires
// them: the background's broadcasts reach it through setupEventBusListeners,
// an UNLOCKED only once the id of the wallet set up has been compared with
// the one the page shows.
describe('a page that loaded before the wallet existed, with the page’s wallet checks in place', () => {
  let checks: ReturnType<typeof installPageChecks>;

  afterEach(() => {
    checks.uninstall();
    forgetShownWalletId();
  });

  // The wallet is saved and announced unlocked; the page, on the settings,
  // then locks and shows the unlock screen.
  async function lockedAfterTheFirstWallet() {
    await loadPageAt('/welcome');
    checks = installPageChecks(store, background.wallet);
    await act(async () => {
      background.state.vault = true;
      checks.broadcast(BUS_METHODS.UNLOCKED);
    });
    // The run the unlock starts records the id of the wallet just saved.
    await waitFor(() => expect(getShownWalletId()).toBe('wallet-1'));
    await goTo('/settings', 'settings_lockwallet');
    await act(async () => {
      background.state.unlocked = false;
      checks.broadcast(BUS_METHODS.LOCKED);
    });
    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
  }

  it('goes to the unlock screen when the wallet locks, and to the wallet at an unlock of that wallet', async () => {
    await lockedAfterTheFirstWallet();
    const idReads = background.wallet.getWalletId.mock.calls.length;

    await act(async () => {
      background.state.unlocked = true;
      checks.broadcast(BUS_METHODS.UNLOCKED);
    });

    await waitFor(() => expect(window.location.hash).toBe('#/main'));
    await screen.findByTestId('home-screen');
    expect(background.wallet.getWalletId.mock.calls.length).toBeGreaterThan(idReads);
    expect(store.getState().global.isUnlocked).toBe(true);
    expect(checks.reloadOnBoot).not.toHaveBeenCalled();
  });

  it('reopens instead at an unlock of another wallet set up since', async () => {
    await lockedAfterTheFirstWallet();
    background.wallet.getWalletId.mockImplementation(async () => 'wallet-2');

    await act(async () => {
      background.state.unlocked = true;
      checks.broadcast(BUS_METHODS.UNLOCKED);
    });

    await waitFor(() => expect(checks.reloadOnBoot).toHaveBeenCalledTimes(1));
    expect(store.getState().global.isUnlocked).toBe(false);
    expect(window.location.hash).toBe('#/account/unlock');
  });
});

describe('a page that loaded with a vault', () => {
  it('goes to the unlock screen when the wallet locks, without waiting for another vault read', async () => {
    background.state.vault = true;
    await loadPageAt('/wallet/receive');
    await screen.findByTestId('receive-loading');

    // The read at the lock never answers.
    background.state.holdVaultReads = true;
    await lock();

    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    expect(background.wallet.hasVault).toHaveBeenCalledTimes(2);
  });
});

describe('the page a first wallet is restored in', () => {
  // A valid 24-word phrase; the import step asks for 24 words by default.
  const MNEMONIC = `${'abandon '.repeat(23)}art`;
  const REPORT = {
    network: 'mainnet',
    accountsRestored: 1,
    discovery: { activeIndexes: [], highestActiveIndex: -1, scannedCount: 20, truncated: false },
    floorsCompleted: true,
    floorScan: {
      network: 'mainnet',
      keyringsScanned: 1,
      accountsScanned: 1,
      totalObservedSignatures: 0,
      restoredFloorCount: 0,
      floorSources: [],
      gapIndexesWithActivity: [],
      possibleConcurrentInstance: false
    }
  };

  // The password was set in this page, which then imports a phrase; the
  // restore is under way.
  async function startRestore() {
    await loadPageAt('/welcome');
    await announce(BUS_METHODS.UNLOCKED);
    fireEvent.click(await screen.findByTestId('import-wallet-button'));
    fireEvent.paste(await screen.findByTestId('mnemonic-import-word-0'), {
      clipboardData: { getData: () => MNEMONIC }
    });
    fireEvent.click(screen.getByTestId('mnemonic-import-continue-button'));
    const continueButton = await screen.findByTestId('address-type-continue-button');
    // Reaching this step arms the screen's 200 ms tab snap-back timer. Let it
    // run out while the screen is shown, not after the test environment is gone.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    fireEvent.click(continueButton);
    await screen.findByTestId('restore-scanning');
    expect(background.restores).toHaveLength(1);
  }

  // A lock lands while the restore saves the wallet, and the read at the lock
  // finds no vault yet. The vault is saved after all.
  async function restoreWithLockDuringSave() {
    await startRestore();
    await lock();
    // A read at the lock is made at once, so it finds no vault.
    await flush();
    expect(window.location.hash).toBe('#/account/create-hd-wallet');
    background.state.vault = true;
  }

  it('goes to the unlock screen once the restore returns', async () => {
    await restoreWithLockDuringSave();

    await act(async () => {
      background.restores[0]!.finish(REPORT);
    });

    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
  });

  it('goes to the unlock screen once the restore fails after saving the wallet', async () => {
    await restoreWithLockDuringSave();

    // Recording the saved wallet's history fails once the lock has emptied the
    // wallets in memory.
    await act(async () => {
      background.restores[0]!.fail(new Error('no keyring found for the requested account'));
    });

    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
  });

  // The restore has saved the wallet and is still scanning when the wallet
  // locks, so the read at the lock finds the vault. A second wallet's restore
  // was sent to the unlock screen the same way already.
  it.each([
    ['returns', (restore: Restore) => restore.finish(REPORT)],
    ['fails', (restore: Restore) => restore.fail(new Error('no keyring found for the requested account'))]
  ])(
    'goes to the unlock screen when the wallet locks while the restore scans, and stays there when the restore then %s',
    async (_outcome, settleRestore) => {
      const unhandled: unknown[] = [];
      const noteUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', noteUnhandled);
      try {
        await startRestore();
        background.state.vault = true;

        await lock();
        await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
        await screen.findByTestId('unlock-password-input');

        await act(async () => {
          settleRestore(background.restores[0]!);
        });
        await flush();
        await flush();

        expect(unhandled).toEqual([]);
        expect(window.location.hash).toBe('#/account/unlock');
        expect(screen.getByTestId('unlock-password-input')).toBeTruthy();
        expect(screen.queryByTestId('restore-report-page')).toBeNull();
      } finally {
        process.off('unhandledRejection', noteUnhandled);
      }
    }
  );

  it('goes to the unlock screen when the wallet locks after the report is shown', async () => {
    await startRestore();
    background.state.vault = true;
    await act(async () => {
      background.restores[0]!.finish(REPORT);
    });
    await screen.findByTestId('restore-report-page');
    expect(screen.getByTestId('restore-report-warning-counters')).toBeTruthy();

    await lock();

    await waitFor(() => expect(window.location.hash).toBe('#/account/unlock'));
    await screen.findByTestId('unlock-password-input');
    // The report, and its notices, are not shown again.
    expect(screen.queryByTestId('restore-report-page')).toBeNull();
    expect(screen.queryByTestId('restore-report-warning-counters')).toBeNull();
  });
});
