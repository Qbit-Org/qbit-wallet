import { useEffect, useRef, useState } from 'react';

import { Card, Column, Content, Footer, Header, Icon, Layout, Row, Text, Tooltip } from '@/ui/components';
import AccountSelect from '@/ui/components/AccountSelect';
import { FeeRateIcon } from '@/ui/components/FeeRateIcon';
import LoadingPage from '@/ui/components/LoadingPage';
import { NavTabBar } from '@/ui/components/NavTabBar';
import { SwitchNetworkBar } from '@/ui/components/SwitchNetworkBar';
import { ThemeToggle } from '@/ui/components/ThemeToggle';
import { UpgradePopover } from '@/ui/components/UpgradePopover';
import { VersionNotice } from '@/ui/components/VersionNotice';
import { fontSizes } from '@/ui/theme/font';
import { getCurrentTab } from '@/ui/web/tabs';
import { walletErrorMessage } from '@/ui/utils';
import { KeyringType } from '@qbit/keyring-service/types';
import { BUS_METHODS, QbitRecoveryState, VersionDetail } from '@qbit/wallet-shared';
import '@qbit/wallet-state';
import {
  uiEventBus,
  useChain,
  useCurrentAccount,
  useCurrentKeyring,
  useI18n,
  useIsUnlocked,
  useNavigation,
  useSkipVersionCallback,
  useTools,
  useVersionInfo,
  useWallet
} from '@qbit/wallet-state';

import { useNavigate } from '../../MainRoute';
import { SwitchChainModal } from '../../Settings/SwitchChainModal';
import { LockWalletButton } from './LockWalletButton';
import { SidePanelExpand } from './SidePanelExpand';
import { AnnouncementCard } from './components/AnnouncementCard';
import { BalanceCard } from './components/BalanceCard';
import { HomeTips } from './components/HomeTips';
import { WalletActions } from './components/WalletActions';
import { QbitRecoveryWarning } from './components/QbitRecoveryWarning';

const STORAGE_VERSION_KEY = 'version_detail';

export default function WalletTabScreen() {
  const navigate = useNavigate();

  const chain = useChain();

  const currentKeyring = useCurrentKeyring();
  const currentAccount = useCurrentAccount();

  const wallet = useWallet();
  const tools = useTools();
  const { t } = useI18n();
  const [connected, setConnected] = useState(false);
  const [continuedUseAccepted, setContinuedUseAccepted] = useState(false);
  const [recoveryState, setRecoveryState] = useState<QbitRecoveryState | undefined>(currentKeyring.qbitRecovery);

  const skipVersion = useSkipVersionCallback();

  const versionInfo = useVersionInfo();

  const [showVersionNotice, setShowVersionNotice] = useState<VersionDetail | null>(null);

  const nav = useNavigation();
  const isUnlocked = useIsUnlocked();

  useEffect(() => {
    if (!isUnlocked) {
      nav.navToLock({
        autoUnlockByFace: false
      });
    }
  }, [isUnlocked]);

  useEffect(() => {
    const run = async () => {
      wallet.getNotifications();

      const activeTab = await getCurrentTab();
      if (!activeTab) return;
      const site = await wallet.getCurrentConnectedSite(activeTab.id);
      if (site) {
        setConnected(site.isConnected);
      }
    };
    run();
  }, []);

  // Tracks which keyring the screen currently shows recovery state for, so a
  // mutation response that resolves after a keyring switch (or unmount) is
  // dropped instead of overwriting the new keyring's state.
  const activeRecoveryKeyringKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setContinuedUseAccepted(false);
  }, [currentKeyring.index, recoveryState?.status]);

  useEffect(() => {
    setRecoveryState(currentKeyring.qbitRecovery);
  }, [currentKeyring.index, currentKeyring.qbitRecovery]);

  useEffect(() => {
    if (currentKeyring.type !== KeyringType.QbitHdKeyring) {
      activeRecoveryKeyringKeyRef.current = null;
      return;
    }

    const keyringIndex = currentKeyring.index;
    // Keyring removal compacts indexes while this screen stays mounted, so
    // the refresh resolves the wallet by its anchor pubkey like the
    // acknowledge/dismiss calls below; the captured index only breaks ties.
    const anchorPubkey = currentKeyring.accounts[0]?.pubkey;
    activeRecoveryKeyringKeyRef.current = currentKeyring.key;

    let cancelled = false;
    let latestRequestId = 0;
    const refresh = () => {
      const requestId = ++latestRequestId;
      wallet
        .getQbitRecoveryState(keyringIndex, anchorPubkey)
        .then((state) => {
          if (cancelled || requestId !== latestRequestId) return;
          setRecoveryState(state);
        })
        .catch(() => {
          // Keep the last known snapshot; the next mutation broadcast retries.
        });
    };

    // The redux keyring snapshot only refreshes when the selected account key
    // changes, so recovery lifecycle mutations (acknowledgement, migration
    // transitions) leave it stale. Fetch the authoritative state on mount and
    // whenever the background broadcasts an account change.
    refresh();
    uiEventBus.addEventListener(BUS_METHODS.ACCOUNTS_CHANGED, refresh);
    return () => {
      cancelled = true;
      uiEventBus.removeEventListener(BUS_METHODS.ACCOUNTS_CHANGED, refresh);
      activeRecoveryKeyringKeyRef.current = null;
    };
  }, [currentKeyring.key, currentKeyring.index, currentKeyring.type, wallet]);

  useEffect(() => {
    const run = async () => {
      try {
        const item = localStorage.getItem(STORAGE_VERSION_KEY);
        if (!item) {
          // A missing cache means a fresh install (or cleared storage), not an
          // update; seed it silently so only genuine version changes surface
          // the notice.
          localStorage.setItem(STORAGE_VERSION_KEY, JSON.stringify({ version: versionInfo.currentVesion }));
          return;
        }
        const cached: VersionDetail = JSON.parse(item);
        if (cached.version === versionInfo.currentVesion) {
          return;
        }
        const versionDetail = await wallet.getVersionDetail(versionInfo.currentVesion);

        if (versionDetail && versionDetail.notice) {
          // Cached only on dismiss, so a popup closed mid-notice shows it again.
          setShowVersionNotice(versionDetail);
        } else {
          localStorage.setItem(STORAGE_VERSION_KEY, JSON.stringify(versionDetail));
        }
      } catch (e) {
        console.log(e);
      }
    };
    run();
  }, []);

  const [switchChainModalVisible, setSwitchChainModalVisible] = useState(false);

  if (!currentAccount.address) {
    return <LoadingPage />;
  }
  return (
    <Layout>
      <Header
        type="home"
        LeftComponent={
          <Row itemsCenter>
            <Tooltip
              title={t('switch_wallet')}
              overlayStyle={{
                minWidth: '70px',
                fontSize: '12px'
              }}
              placement="bottom"
            >
              <Card
                preset="style2"
                style={{ height: 28 }}
                onClick={() => {
                  navigate('SwitchKeyringScreen');
                }}
                data-testid="wallet-management-entry"
              >
                <Row itemsCenter gap="sm">
                  <Icon icon="wallet" size={fontSizes.icon} />
                  <Text text={`${currentKeyring.index + 1}`} size="xxs" />
                </Row>
              </Card>
            </Tooltip>
            <FeeRateIcon />
            <SwitchNetworkBar />
          </Row>
        }
        RightComponent={
          <Row gap="lg" itemsCenter>
            <ThemeToggle />
            <SidePanelExpand />
            <LockWalletButton />
          </Row>
        }
      />

      <Content>
        <AccountSelect />

        <Column gap="lg2" mt="md">
          <HomeTips />

          {recoveryState && recoveryState.status !== 'clean' ? (
            <QbitRecoveryWarning
              // Remount per keyring so collapsed/expanded UI state cannot leak
              // from one recovered wallet's banner to another's.
              key={currentKeyring.key}
              state={recoveryState}
              accepted={continuedUseAccepted}
              onAcceptedChange={setContinuedUseAccepted}
              onAcknowledge={() => {
                const keyringKey = currentKeyring.key;
                void wallet
                  .acknowledgeQbitRecoveryRisk(currentKeyring.index, currentKeyring.accounts[0]?.pubkey)
                  .then((state) => {
                    if (activeRecoveryKeyringKeyRef.current !== keyringKey) return;
                    setRecoveryState(state);
                    setContinuedUseAccepted(false);
                  })
                  .catch((error) => tools.toastError(walletErrorMessage(error, t('unknown_error'))));
              }}
              onDismiss={() => {
                const keyringKey = currentKeyring.key;
                void wallet
                  .dismissQbitRecoveryWarning(currentKeyring.index, currentKeyring.accounts[0]?.pubkey)
                  .then((state) => {
                    if (activeRecoveryKeyringKeyRef.current !== keyringKey) return;
                    setRecoveryState(state);
                  })
                  .catch((error) => tools.toastError(walletErrorMessage(error, t('unknown_error'))));
              }}
              onMoveFunds={() =>
                navigate('QbitRecoveryMigrationScreen', {
                  sourceKeyringIndex: currentKeyring.index,
                  sourceAnchorPubkey: currentKeyring.accounts[0]?.pubkey
                })
              }
            />
          ) : null}

          <BalanceCard />
          <WalletActions chain={chain} hideReceive={recoveryState?.status === 'migrated'} />

          <AnnouncementCard />
        </Column>
        {!versionInfo.skipped && (
          <UpgradePopover
            onClose={() => {
              skipVersion(versionInfo.newVersion);
            }}
          />
        )}

        {switchChainModalVisible && (
          <SwitchChainModal
            onClose={() => {
              setSwitchChainModalVisible(false);
            }}
          />
        )}

        {showVersionNotice && (
          <VersionNotice
            notice={showVersionNotice}
            onClose={() => {
              localStorage.setItem(STORAGE_VERSION_KEY, JSON.stringify(showVersionNotice));
              setShowVersionNotice(null);
            }}
          />
        )}
      </Content>
      <Footer px="zero" py="zero">
        <NavTabBar tab="home" />
      </Footer>
    </Layout>
  );
}
