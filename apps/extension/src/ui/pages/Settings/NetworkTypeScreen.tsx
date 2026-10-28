import { useState } from 'react';

import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { Card, Column, Content, Header, Icon, Image, Layout, Row } from '@/ui/components';
import { isRegtestLocked, regtestAccessErrorMessage, useRegtestAccessStatus } from '@/ui/utils/regtestAccess';
import { CHAINS, CHAINS_MAP } from '@qbit/wallet-shared';
import { useChainType, useChangeChainTypeCallback, useI18n, useReloadAccounts, useTools } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';

import { useNavigate } from '../MainRoute';
import { NETWORK_OPTION_ROW_HEIGHT, NetworkOptionLabel } from './NetworkOptionLabel';
import RegtestAccessModal from './RegtestAccessModal';

export default function NetworkTypeScreen() {
  const chainType = useChainType();
  const changeChainType = useChangeChainTypeCallback();
  const reloadAccounts = useReloadAccounts();
  const tools = useTools();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { status: regtestAccess } = useRegtestAccessStatus();
  const [enableRegtestVisible, setEnableRegtestVisible] = useState(false);
  const regtestLocked = isRegtestLocked(regtestAccess);

  const selectChain = async (chain: ChainType, label: string) => {
    if (chain === chainType) {
      return;
    }
    try {
      // The background guard is the authority: a locked, unreachable or
      // unexpected local service rejects the switch and the current network
      // stays selected.
      await changeChainType(chain);
    } catch (error) {
      tools.toastError(regtestAccessErrorMessage(error, t) ?? t('this_network_is_not_available'));
      return;
    }
    reloadAccounts();
    navigate('MainScreen');
    tools.toastSuccess(`${t('changed_to_network')} ${label}`);
  };

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('select_network')}
      />
      <Content>
        <Column>
          {CHAINS.map((item, index) => {
            const lockedRegtest = item.enum === ChainType.QBIT_REGTEST && regtestLocked;
            return (
              <Card
                key={index}
                data-testid={`network-option-${item.enum}`}
                onClick={async () => {
                  if (item.disable) {
                    return tools.toastError(t('this_network_is_not_available'));
                  }
                  if (lockedRegtest) {
                    // Not selectable yet: the row itself opens the explanation
                    // instead of switching.
                    setEnableRegtestVisible(true);
                    return;
                  }
                  await selectChain(item.enum, item.label);
                }}
              >
                <Row full justifyBetween itemsCenter>
                  <Row itemsCenter>
                    <Image
                      src={IMAGE_SOURCE_MAP[item.icon]}
                      size={NETWORK_OPTION_ROW_HEIGHT}
                      style={{ opacity: item.disable || lockedRegtest ? 0.7 : 1 }}
                    />
                    <NetworkOptionLabel
                      label={lockedRegtest ? t('local_regtest') : item.label}
                      subtext={item.enum === ChainType.QBIT_REGTEST ? item.endpoints[0] : undefined}
                      preset="regular-bold"
                      color={item.disable ? 'textDim' : 'text'}
                    />
                  </Row>
                  <Column>{item.enum == chainType && <Icon icon="check" />}</Column>
                </Row>
              </Card>
            );
          })}
        </Column>
        {enableRegtestVisible && (
          <RegtestAccessModal
            onBack={() => setEnableRegtestVisible(false)}
            onEnabled={async () => {
              // Selecting the row was the initiating action, so switch now.
              setEnableRegtestVisible(false);
              await selectChain(ChainType.QBIT_REGTEST, CHAINS_MAP[ChainType.QBIT_REGTEST].label);
            }}
          />
        )}
      </Content>
    </Layout>
  );
}
