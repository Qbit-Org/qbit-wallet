/**
 * UI Entry Point
 * Main entry file for the extension UI
 */
import ReactDOM from 'react-dom/client';
import { IdleTimerProvider } from 'react-idle-timer';
import { Provider } from 'react-redux';

import { initPlatformEnv } from '@/shared/initPlatformEnv';
import '@/ui/styles/global.less';
import { AccountUpdater, createAppStore, WalletProvider } from '@qbit/wallet-state';

import { i18nService } from '@/shared/utils/i18n';
import { PlatformEnv } from '@qbit/wallet-shared';
import { AppDimensions } from './components/Responsive';
import { StartupErrorScreen } from './components/StartupErrorScreen';
import { WalletResetNotice } from './components/WalletResetNotice';
import AsyncMainRoute from './pages/MainRoute';
import { DeviceProvider } from './providers/DeviceProvider';
import { I18nProvider } from './providers/I18nProvider';
import { ThemeProvider } from './providers/ThemeProvider';
import { ToolsProvider } from './providers/ToolsProvider';
import { initializeAppConfig } from './utils/appConfig';
import { BackgroundStartupFailure, waitForBackgroundReady, waitForBackgroundStartup } from './utils/backgroundStartup';
import { applyExternalMonitorFix } from './utils/platformFixes';
import {
  createReconnectReconcile,
  createUnlockGate,
  getShownWalletId,
  installPageWalletResetHandler,
  noteWalletDataOwnerAtLoad,
  pageShowsWalletContent,
  RECONNECT_STARTUP_WAIT_MS,
  refuseWithoutWalletId,
  reopenOutOfDatePage,
  waitForShownWalletId
} from './utils/walletReset';
import { noteWalletActivity } from './utils/walletActivity';
import { noteWalletOpened } from './utils/walletOpened';
import {
  createPortMessageChannel,
  createWalletProxy,
  setupEventBusListeners,
  watchPortReconnects
} from './web/ui-messaging';
// Initialize platform environment
initPlatformEnv();

// Initialize application configuration
initializeAppConfig();

// Apply platform-specific fixes
applyExternalMonitorFix();

const store = createAppStore();
// Which wallet the keys it loaded its saved `ui` slice from belong to.
noteWalletDataOwnerAtLoad();

// Every window answers the background's WALLET_RESET the same way, from
// before its first render: it drops the erased wallets' state and reopens on
// the Welcome screen.
installPageWalletResetHandler(store);

i18nService.init({});

// Setup communication channels
const portMessageChannel = createPortMessageChannel();
// Set below, once the page's checks exist; an unlock comes much later.
let unlockGate: ReturnType<typeof createUnlockGate> | undefined = undefined;
// What of a wallet the page shows: the wallet proxy and the checks below go
// by it.
const showsWalletContent = () => pageShowsWalletContent(store.getState());
// Each call carries the id of the wallet this page shows, and the background
// refuses it (-22) if another wallet, or none, is set up now: the page then
// reopens at once. A page that shows wallet content but holds no id sends no
// call but the exempt ones: each waits for the id read under way, or is
// refused here, in the -22 shape.
const wallet = createWalletProxy(portMessageChannel, {
  afterUnlock: async () => unlockGate?.afterUnlock(),
  walletId: getShownWalletId,
  onOutOfDate: reopenOutOfDatePage,
  showsWalletContent,
  waitForWalletId: () => waitForShownWalletId(),
  refuseWithoutWalletId: () => refuseWithoutWalletId(i18nService.translate('wallet_page_out_of_date'))
});

// Setup event bus listeners
setupEventBusListeners(portMessageChannel, {
  beforeUnlocked: async () => unlockGate?.beforeUnlockedBroadcast() ?? true
});

// A background that started again may have finished a reset this page did
// not hear of while its connection was down, and a wallet may have been made
// in another window since: a page holding a wallet checks, by the id of the
// one it shows, that the background still holds that one, once its
// connection comes back and at each unlock, before the unlock shows anything:
// its own, by password or Touch ID, or one the background announces.
const holdsWallet = () => {
  const { global, keyrings } = store.getState();
  return global.isBooted || keyrings.keyrings.length > 0;
};
const shownWalletReads = {
  isBooted: () => wallet.isBooted(),
  getWalletId: () => wallet.getWalletId()
};
const checkAfterReconnect = createReconnectReconcile({
  holdsWallet,
  shownWalletId: getShownWalletId,
  showsWalletContent,
  wallet: shownWalletReads,
  waitForStartup: () =>
    waitForBackgroundReady(wallet as Parameters<typeof waitForBackgroundReady>[0], RECONNECT_STARTUP_WAIT_MS)
});
watchPortReconnects(portMessageChannel, checkAfterReconnect);
unlockGate = createUnlockGate({
  holdsWallet,
  shownWalletId: getShownWalletId,
  showsWalletContent,
  isStarted: () => store.getState().global.isReady,
  isUnlocked: () => store.getState().global.isUnlocked,
  wallet: shownWalletReads,
  onUnknown: checkAfterReconnect,
  refusal: () => i18nService.translate('wallet_page_out_of_date')
});

// Ensure background is initialized before rendering UI

function renderApp() {
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  root.render(
    <Provider store={store}>
      <WalletProvider wallet={wallet as any}>
        <ThemeProvider>
          <DeviceProvider>
            <I18nProvider>
              <ToolsProvider>
                <AppDimensions>
                  <IdleTimerProvider
                    onAction={() => {
                      noteWalletActivity(wallet as Parameters<typeof noteWalletActivity>[0]);
                    }}>
                    <AccountUpdater />
                    <WalletResetNotice />
                    <AsyncMainRoute />
                  </IdleTimerProvider>
                </AppDimensions>
              </ToolsProvider>
            </I18nProvider>
          </DeviceProvider>
        </ThemeProvider>
      </WalletProvider>
    </Provider>
  );
}

function renderStartupError(failure: BackgroundStartupFailure) {
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  root.render(<StartupErrorScreen reason={failure.reason} />);
}

async function waitUntilReady() {
  if (PlatformEnv.READY_TO_RENDER) {
    renderApp();
    return;
  }
  const status = await waitForBackgroundStartup(wallet as any);
  if (status.state === 'failed') {
    renderStartupError(status);
    return;
  }
  PlatformEnv.READY_TO_RENDER = true;
  renderApp();
  // Opening the popup or the side panel counts as a screen action, once per
  // page load: this point runs once, and only after start-up succeeded.
  noteWalletOpened(wallet as Parameters<typeof noteWalletOpened>[0]);
}

waitUntilReady();
