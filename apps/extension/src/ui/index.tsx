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
import AsyncMainRoute from './pages/MainRoute';
import { DeviceProvider } from './providers/DeviceProvider';
import { I18nProvider } from './providers/I18nProvider';
import { ThemeProvider } from './providers/ThemeProvider';
import { ToolsProvider } from './providers/ToolsProvider';
import { initializeAppConfig } from './utils/appConfig';
import { BackgroundStartupFailure, waitForBackgroundStartup } from './utils/backgroundStartup';
import { applyExternalMonitorFix } from './utils/platformFixes';
import { noteWalletOpened } from './utils/walletOpened';
import { createPortMessageChannel, createWalletProxy, setupEventBusListeners } from './web/ui-messaging';
// Initialize platform environment
initPlatformEnv();

// Initialize application configuration
initializeAppConfig();

// Apply platform-specific fixes
applyExternalMonitorFix();

const store = createAppStore();

i18nService.init({});

// Setup communication channels
const portMessageChannel = createPortMessageChannel();
const wallet = createWalletProxy(portMessageChannel);

// Setup event bus listeners
setupEventBusListeners(portMessageChannel);

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
                      wallet.setLastActiveTime();
                    }}>
                    <AccountUpdater />
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
