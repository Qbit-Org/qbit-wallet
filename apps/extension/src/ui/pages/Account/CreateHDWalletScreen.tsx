import { useCallback, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Content, Header, Layout, Row } from '@/ui/components';
import { TabBar } from '@/ui/components/TabBar';
import { Step1_Create } from '@/ui/pages/Account/createHDWalletComponents/Step1_Create';
import { Step1_Confirm } from '@/ui/pages/Account/createHDWalletComponents/Step1_Confirm';
import { Step1_Import } from '@/ui/pages/Account/createHDWalletComponents/Step1_Import';
import { Step2 } from '@/ui/pages/Account/createHDWalletComponents/Step2';
import { ContextData, TabType, UpdateContextDataParams } from '@/ui/pages/Account/createHDWalletComponents/types';
import { useWalletKeepalive } from '@/ui/utils/hooks';
import { WordsType } from '@qbit/wallet-shared';
import { useI18n, useWallet } from '@qbit/wallet-state';
import { AddressType } from '@qbit/wallet-types';

import { useNavigate } from '../MainRoute';

export default function CreateHDWalletScreen() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { state } = useLocation();
  const { isImport, fromUnlock } = state as {
    isImport: boolean;
    fromUnlock: boolean;
  };

  const [contextData, setContextData] = useState<ContextData>({
    mnemonics: '',
    hdPath: '',
    passphrase: '',
    addressType: AddressType.P2MR,
    step1CreateWordsCompleted: false,
    tabType: isImport ? TabType.IMPORT_WORDS : TabType.CREATE_WORDS,
    isRestore: isImport,
    isCustom: false,
    customHdPath: '',
    addressTypeIndex: 0,
    wordsType: WordsType.WORDS_24,
    restoreScanning: false
  });

  // Functional update: callers include deferred closures (the TabBar snap-back
  // timer, async step hooks), and merging onto a closure-captured contextData
  // would resurrect stale fields — CI lost the typed passphrase this way.
  const updateContextData = useCallback((params: UpdateContextDataParams) => {
    setContextData((previous) => ({ ...previous, ...params }));
  }, []);

  const wallet = useWallet();
  // Keep the wallet active during onboarding for at most ten minutes.
  useWalletKeepalive(wallet);

  const items = useMemo(() => {
    if (contextData.isRestore) {
      return [
        {
          key: TabType.IMPORT_WORDS,
          label: t('step_1'),
          children: <Step1_Import contextData={contextData} updateContextData={updateContextData} />
        },
        {
          key: TabType.CHOOSE_ADDRESS_TYPE,
          label: t('step_2'),
          children: <Step2 contextData={contextData} updateContextData={updateContextData} />
        }
      ];
    } else {
      return [
        {
          key: TabType.CREATE_WORDS,
          label: t('step_1'),
          children: <Step1_Create contextData={contextData} updateContextData={updateContextData} />
        },
        {
          key: TabType.VERIFY_WORDS,
          label: t('step_2'),
          children: <Step1_Confirm contextData={contextData} updateContextData={updateContextData} />
        },
        {
          key: TabType.CHOOSE_ADDRESS_TYPE,
          label: t('step_3'),
          children: <Step2 contextData={contextData} updateContextData={updateContextData} />
        }
      ];
    }
  }, [contextData, updateContextData]);

  const currentChildren = useMemo(() => {
    const item = items.find((v) => v.key === contextData.tabType);
    return item?.children;
  }, [items, contextData.tabType]);

  const activeTabIndex = useMemo(() => {
    const index = items.findIndex((v) => v.key === contextData.tabType);
    if (index === -1) {
      return 0;
    } else {
      return index;
    }
  }, [items, contextData.tabType]);
  return (
    <Layout>
      <Header
        onBack={() => {
          if (fromUnlock) {
            navigate('WelcomeScreen');
          } else {
            window.history.go(-1);
          }
        }}
        backDisabled={contextData.restoreScanning}
        title={contextData.isRestore ? t('restore_from_mnemonics') : t('create_a_new_hd_wallet')}
      />
      <Content>
        <Row
          justifyCenter
          style={contextData.restoreScanning ? { pointerEvents: 'none' } : undefined}
          data-testid="hd-wallet-tabbar"
        >
          <TabBar
            progressEnabled
            defaultActiveKey={contextData.tabType}
            activeKey={contextData.tabType}
            items={items.map((v) => ({
              key: v.key,
              label: v.label
            }))}
            onTabClick={(key) => {
              const toTabType = key as TabType;
              // The chain scan cannot be cancelled; leaving this step would
              // orphan it and lose the restore report.
              if (contextData.restoreScanning) {
                return;
              }
              if (toTabType === TabType.CHOOSE_ADDRESS_TYPE) {
                if (!contextData.step1CreateWordsCompleted) {
                  setTimeout(() => {
                    updateContextData({ tabType: contextData.tabType });
                  }, 200);
                  return;
                }
              }
              updateContextData({ tabType: toTabType });
            }}
          />
        </Row>

        {currentChildren}
      </Content>
    </Layout>
  );
}
