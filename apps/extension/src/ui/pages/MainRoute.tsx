import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate as useNavigateOrigin } from 'react-router-dom';

import {
  accountActions,
  globalActions,
  settingsActions,
  useAppDispatch,
  useIsReady,
  useIsUnlocked,
  useWallet
} from '@qbit/wallet-state';

import { Content, Icon } from '../components';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ApprovalProvider } from '../providers/ApprovalProvider';
import { NavigationProvider } from '../providers/NavigationProvider';
import AddKeyringScreen from './Account/AddKeyringScreen';
import CreateAccountScreen from './Account/CreateAccountScreen';
import CreateHDWalletScreen from './Account/CreateHDWalletScreen';
import CreatePasswordScreen from './Account/CreatePasswordScreen';
import CreateReadonlyWalletScreen from './Account/CreateReadonlyWalletScreen';
import CreateWatchWalletScreen from './Account/CreateWatchWalletScreen';
import SwitchAccountScreen from './Account/SwitchAccountScreen';
import SwitchKeyringScreen from './Account/SwitchKeyringScreen';
import UnlockScreen from './Account/UnlockScreen';
import ApprovalScreen from './Approval/ApprovalScreen';
import ConnectedSitesScreen from './Approval/ConnectedSitesScreen';
import BoostScreen from './Main/BoostScreen';
import DiscoverTabScreen from './Main/DiscoverTabScreen';
import SettingsTabScreen from './Main/SettingsTabScreen';
import WalletTabScreen from './Main/WalletTabScreen';
import WelcomeScreen from './Main/WelcomeScreen';
import PhishingScreen from './Phishing/PhishingScreen';
import AboutUsScreen from './Settings/AboutUsScreen';
import AddressTypeScreen from './Settings/AddressTypeScreen';
import AdvancedScreen from './Settings/AdvancedScreen';
import { LockTimePage } from './Settings/AdvancedScreen/LockTimePage';
import { RegtestAccessScreen } from './Settings/AdvancedScreen/RegtestAccessScreen';
import ChangePasswordScreen from './Settings/ChangePasswordScreen';
import ContactsScreen from './Settings/ContactsScreen';
import EditAccountNameScreen from './Settings/EditAccountNameScreen';
import EditContactScreen from './Settings/EditContactScreen';
import EditWalletNameScreen from './Settings/EditWalletNameScreen';
import ExportMnemonicsScreen from './Settings/ExportMnemonicsScreen';
import ExportPrivateKeyScreen from './Settings/ExportPrivateKeyScreen';
import AppearanceScreen from './Settings/AppearanceScreen';
import BiometricUnlockScreen from './Settings/BiometricUnlockScreen';
import LanguageScreen from './Settings/LanguageScreen';
import NetworkTypeScreen from './Settings/NetworkTypeScreen';
import NotificationListScreen from './Settings/NotificationListScreen';
import UpgradeNoticeScreen from './Settings/UpgradeNoticeScreen';
import TestScreen from './Test/TestScreen';
import HistoryScreen from './Wallet/HistoryScreen';
import QbitConsolidationScreen from './Wallet/QbitConsolidationScreen';
import QbitRecoveryMigrationScreen from './Wallet/QbitRecoveryMigrationScreen';
import ReceiveScreen from './Wallet/ReceiveScreen';
import TxConfirmScreen from './Wallet/TxConfirmScreen';
import TxCreateScreen from './Wallet/TxCreateScreen';
import TxFailScreen from './Wallet/TxFailScreen';
import TxSuccessScreen from './Wallet/TxSuccessScreen';
import './index.module.less';

const isDevelopment = process.env.NODE_ENV === 'development';

export const routes = {
  BoostScreen: {
    path: '/',
    element: <BoostScreen />
  },
  WelcomeScreen: {
    path: '/welcome',
    element: <WelcomeScreen />
  },
  MainScreen: {
    path: '/main',
    element: <WalletTabScreen />
  },
  DiscoverTabScreen: {
    path: '/discover',
    element: <DiscoverTabScreen />
  },
  AppTabScreen: {
    path: '/app',
    element: <Navigate to="/discover" replace />
  },
  NotificationListScreen: {
    path: '/notifications',
    element: <NotificationListScreen />
  },
  SettingsTabScreen: {
    path: '/settings',
    element: <SettingsTabScreen />
  },
  CreateHDWalletScreen: {
    path: '/account/create-hd-wallet',
    element: <CreateHDWalletScreen />
  },
  CreateAccountScreen: {
    path: '/account/create',
    element: <CreateAccountScreen />
  },
  CreatePasswordScreen: {
    path: '/account/create-password',
    element: <CreatePasswordScreen />
  },
  UnlockScreen: {
    path: '/account/unlock',
    element: <UnlockScreen />
  },
  SwitchAccountScreen: {
    path: '/account/switch-account',
    element: <SwitchAccountScreen />
  },
  ReceiveScreen: {
    path: '/wallet/receive',
    element: <ReceiveScreen />
  },
  QbitRecoveryMigrationScreen: {
    path: '/wallet/qbit-recovery-migration',
    element: <QbitRecoveryMigrationScreen />
  },

  TxCreateScreen: {
    path: '/wallet/tx/create',
    element: <TxCreateScreen />
  },
  QbitConsolidationScreen: {
    path: '/wallet/tx/consolidate',
    element: <QbitConsolidationScreen />
  },
  TxConfirmScreen: {
    path: '/wallet/tx/confirm',
    element: <TxConfirmScreen />
  },
  TxSuccessScreen: {
    path: '/wallet/tx/success',
    element: <TxSuccessScreen />
  },
  TxFailScreen: {
    path: '/wallet/tx/fail',
    element: <TxFailScreen />
  },

  NetworkTypeScreen: {
    path: '/settings/network-type',
    element: <NetworkTypeScreen />
  },
  ChangePasswordScreen: {
    path: '/settings/password',
    element: <ChangePasswordScreen />
  },
  BiometricUnlockScreen: {
    path: '/settings/biometric',
    element: <BiometricUnlockScreen />
  },
  ExportMnemonicsScreen: {
    path: '/settings/export-mnemonics',
    element: <ExportMnemonicsScreen />
  },
  ExportPrivateKeyScreen: {
    path: '/settings/export-privatekey',
    element: <ExportPrivateKeyScreen />
  },
  AdvancedScreen: {
    path: '/settings/advanced',
    element: <AdvancedScreen />
  },
  LanguageScreen: {
    path: '/settings/language',
    element: <LanguageScreen />
  },
  AppearanceScreen: {
    path: '/settings/appearance',
    element: <AppearanceScreen />
  },
  LockTimePage: {
    path: '/settings/lock-time',
    element: <LockTimePage />
  },
  RegtestAccessScreen: {
    path: '/settings/regtest-access',
    element: <RegtestAccessScreen />
  },
  HistoryScreen: {
    path: '/wallet/history',
    element: <HistoryScreen />
  },
  ApprovalScreen: {
    path: '/approval',
    element: <ApprovalScreen />
  },
  ConnectedSitesScreen: {
    path: '/connected-sites',
    element: <ConnectedSitesScreen />
  },
  SwitchKeyringScreen: {
    path: '/account/switch-keyring',
    element: <SwitchKeyringScreen />
  },
  AddKeyringScreen: {
    path: '/account/add-keyring',
    element: <AddKeyringScreen />
  },
  EditWalletNameScreen: {
    path: '/settings/edit-wallet-name',
    element: <EditWalletNameScreen />
  },
  CreateReadonlyWalletScreen: {
    path: '/account/create-readonly-wallet',
    element: <CreateReadonlyWalletScreen />
  },

  UpgradeNoticeScreen: {
    path: '/settings/upgrade-notice',
    element: <UpgradeNoticeScreen />
  },
  AddressTypeScreen: {
    path: '/settings/address-type',
    element: <AddressTypeScreen />
  },
  ContactsScreen: {
    path: '/settings/contacts',
    element: <ContactsScreen />
  },
  EditContactScreen: {
    path: '/settings/contacts/edit',
    element: <EditContactScreen />
  },
  EditContactWithChainScreen: {
    path: '/settings/contact/:address/:chain',
    element: <EditContactScreen />
  },
  EditAccountNameScreen: {
    path: '/settings/edit-account-name',
    element: <EditAccountNameScreen />
  },
  phishing: {
    path: '/phishing',
    element: <PhishingScreen />
  },

  AboutUsScreen: {
    path: '/settings/about-us',
    element: <AboutUsScreen />
  }
};

if (isDevelopment) {
  routes['TestScreen'] = {
    path: '/test',
    element: <TestScreen />
  };

  routes['CreateWatchWalletScreen'] = {
    path: '/account/create-watch-wallet',
    element: <CreateWatchWalletScreen />
  };
}

export type RouteTypes = keyof typeof routes;

export function useNavigate() {
  const navigate = useNavigateOrigin();
  const navigatingRef = useRef(false);

  return useCallback(
    (routKey: RouteTypes | '#back', state?: any, pathState?: any) => {
      /** Prevent duplicate route entries while navigation is in flight. */
      if (navigatingRef.current) {
        return;
      }

      navigatingRef.current = true;

      if (routKey === '#back') {
        window.history.back();
        navigatingRef.current = false;
        return;
      }

      if (!routes[routKey]) {
        navigatingRef.current = false;
        return;
      }

      const route: any = routes[routKey];
      if (route.getDynamicPath) {
        const path = route.getDynamicPath(pathState);
        navigate(path, { replace: false, state });
        navigatingRef.current = false;
        return;
      }

      navigate(
        {
          pathname: route.path
        },
        { replace: false, state }
      );

      navigatingRef.current = false;
    },
    [navigate]
  );
}

const Main = () => {
  const wallet = useWallet();
  const dispatch = useAppDispatch();

  const isReady = useIsReady();
  const isUnlocked = useIsUnlocked();

  const selfRef = useRef({
    settingsLoaded: false,
    accountLoaded: false,
    configLoaded: false
  });
  const self = selfRef.current;
  const init = useCallback(async () => {
    try {
      if (!self.accountLoaded) {
        const currentAccount = await wallet.getCurrentAccount();
        if (currentAccount) {
          dispatch(accountActions.setCurrent(currentAccount));

          const accounts = await wallet.getAccounts();
          dispatch(accountActions.setAccounts(accounts));

          if (accounts.length > 0) {
            self.accountLoaded = true;
          }
        }
      }

      if (!self.settingsLoaded) {
        const chainType = await wallet.getChainType();
        dispatch(
          settingsActions.updateSettings({
            chainType
          })
        );

        const _locale = await wallet.getLocale();
        dispatch(settingsActions.updateSettings({ locale: _locale }));
        self.settingsLoaded = true;
      }

      if (!self.configLoaded) {
        self.configLoaded = true;

        // already load when reloadAccounts
        // wallet.getWalletConfig().then((data) => {
        //   dispatch(settingsActions.updateSettings({ walletConfig: data }));
        // });
        wallet.getSkippedVersion().then((data) => {
          dispatch(settingsActions.updateSettings({ skippedVersion: data }));
        });

        wallet.getAutoLockTimeId().then((data) => {
          dispatch(settingsActions.updateSettings({ autoLockTimeId: data }));
        });
        wallet.getDeveloperMode().then((data) => {
          dispatch(settingsActions.updateSettings({ developerMode: data }));
        });
      }

      dispatch(globalActions.update({ isReady: true }));
    } catch (e) {
      console.log('init error', e);
    }
  }, [wallet, dispatch, isReady, isUnlocked]);

  useEffect(() => {
    wallet.hasVault().then((val) => {
      if (val) {
        dispatch(globalActions.update({ isBooted: true }));
        wallet.isUnlocked().then((isUnlocked) => {
          dispatch(globalActions.update({ isUnlocked }));
        });
      }
    });
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  if (!isReady) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '400vw',
          height: '00vh',
          overflowY: 'auto',
          overflowX: 'hidden'
        }}
      >
        <Content justifyCenter itemsCenter>
          <Icon>
            <LoaderCircle className="icon-spin" size="1em" />
          </Icon>
        </Content>
      </div>
    );
  }

  return (
    <HashRouter>
      <NavigationProvider>
        <ApprovalProvider>
          <Routes>
            {Object.keys(routes)
              .map((v) => routes[v])
              .map((v) => (
                <Route key={v.path} path={v.path} element={<ErrorBoundary>{v.element}</ErrorBoundary>} />
              ))}
          </Routes>
        </ApprovalProvider>
      </NavigationProvider>
    </HashRouter>
  );
};

export default Main;
