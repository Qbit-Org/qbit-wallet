import { useEffect, useState } from 'react';

import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { Card, Column, Icon, Image, Row, Text } from '@/ui/components';
import { BottomModal } from '@/ui/components/BottomModal';
import { colors } from '@/ui/theme/colors';
import { isRegtestLocked, regtestAccessErrorMessage, useRegtestAccessStatus } from '@/ui/utils/regtestAccess';
import { CHAIN_GROUPS, CHAINS_MAP, TypeChainGroup } from '@qbit/wallet-shared';
import { useChain, useChangeChainTypeCallback, useI18n, useReloadAccounts, useTools } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';

import { NETWORK_OPTION_ROW_HEIGHT, NetworkOptionLabel } from './NetworkOptionLabel';
import RegtestAccessModal from './RegtestAccessModal';

interface RegtestGate {
  locked: boolean;
  openEnable: () => void;
}

function ChainItem(props: { chainType: ChainType; inGroup?: boolean; onClose: () => void; regtest: RegtestGate }) {
  const chain = CHAINS_MAP[props.chainType];

  const currentChain = useChain();
  const selected = currentChain.enum == chain.enum;
  const changeChainType = useChangeChainTypeCallback();
  const reloadAccounts = useReloadAccounts();
  const tools = useTools();
  const { t } = useI18n();
  const lockedRegtest = chain.enum === ChainType.QBIT_REGTEST && props.regtest.locked;
  return (
    <Card
      data-testid={`chain-item-${chain.enum}`}
      style={Object.assign(
        {},
        {
          borderRadius: 0,
          borderColor: colors.gold,
          borderWidth: selected ? 1 : 0
        },
        props.inGroup
          ? { backgroundColor: 'transparent', marginTop: 6 }
          : {
              backgroundColor: chain.disable ? colors.surfaceMuted : colors.surface,
              marginTop: 12
            }
      )}
      onClick={async () => {
        if (chain.disable) {
          return tools.toastError(t('this_network_is_not_available'));
        }
        if (lockedRegtest) {
          // The locked row is the only affordance: it opens the explanation
          // and never switches directly.
          props.regtest.openEnable();
          return;
        }

        if (currentChain.enum == chain.enum) {
          return;
        }
        try {
          await changeChainType(chain.enum);
        } catch (error) {
          tools.toastError(regtestAccessErrorMessage(error, t) ?? t('this_network_is_not_available'));
          return;
        }
        props.onClose();
        reloadAccounts();
        tools.toastSuccess(`${t('changed_to_network')} ${chain.label}`);
      }}
    >
      <Row fullX itemsCenter>
        <Image
          src={IMAGE_SOURCE_MAP[chain.icon]}
          size={NETWORK_OPTION_ROW_HEIGHT}
          style={{ opacity: chain.disable || lockedRegtest ? 0.7 : 1 }}
        />
        <NetworkOptionLabel
          label={lockedRegtest ? t('local_regtest') : chain.label}
          subtext={chain.enum === ChainType.QBIT_REGTEST ? chain.endpoints[0] : undefined}
          color={chain.disable ? 'textDim' : 'text'}
        />
      </Row>
    </Card>
  );
}

function ChainGroup(props: { group: TypeChainGroup; onClose: () => void; regtest: RegtestGate }) {
  const group = props.group;
  const currentChain = useChain();

  const [folded, setFolded] = useState(true);

  useEffect(() => {
    if (group.type === 'list') {
      let defaultFolded = true;
      if (group.items && group.items.find((v) => v.enum == currentChain.enum)) {
        defaultFolded = false;
      }
      setFolded(defaultFolded);
    }
  }, [currentChain]);

  if (group.type === 'single') {
    return <ChainItem chainType={group.chain!.enum} onClose={props.onClose} regtest={props.regtest} />;
  } else {
    return (
      <Column>
        <Card
          style={{
            backgroundColor: colors.surface,
            borderRadius: 0,
            borderColor: colors.gold,
            borderWidth: 0
          }}
          mt="lg"
          onClick={() => {
            setFolded(!folded);
          }}
        >
          <Column fullX gap="zero">
            <Row fullX justifyBetween itemsCenter>
              <Row itemsCenter>
                <Image src={IMAGE_SOURCE_MAP[group.icon!]} size={30} />
                <Text text={group.label} color={'text'} />
              </Row>
              {folded ? <Icon icon="down" /> : <Icon icon="up" />}
            </Row>
            {!folded ? (
              <Row
                style={{ borderTopWidth: 1, borderColor: colors.border, alignSelf: 'stretch', width: '100%' }}
                my="md"
              />
            ) : null}

            {!folded ? (
              <Column gap="zero">
                {group.items &&
                  group.items.map((v) => (
                    <ChainItem
                      key={v.enum}
                      inGroup
                      chainType={v.enum}
                      onClose={props.onClose}
                      regtest={props.regtest}
                    />
                  ))}
              </Column>
            ) : null}
          </Column>
        </Card>
      </Column>
    );
  }
}

export const SwitchChainModal = ({ onClose }: { onClose: () => void }) => {
  const { t } = useI18n();
  const tools = useTools();
  const changeChainType = useChangeChainTypeCallback();
  const reloadAccounts = useReloadAccounts();
  const { status: regtestAccess } = useRegtestAccessStatus();
  const [enableRegtestVisible, setEnableRegtestVisible] = useState(false);
  const regtest: RegtestGate = {
    locked: isRegtestLocked(regtestAccess),
    openEnable: () => setEnableRegtestVisible(true)
  };

  const switchToRegtestAfterEnable = async () => {
    setEnableRegtestVisible(false);
    try {
      await changeChainType(ChainType.QBIT_REGTEST);
    } catch (error) {
      tools.toastError(regtestAccessErrorMessage(error, t) ?? t('this_network_is_not_available'));
      return;
    }
    onClose();
    reloadAccounts();
    tools.toastSuccess(`${t('changed_to_network')} ${CHAINS_MAP[ChainType.QBIT_REGTEST].label}`);
  };

  return (
    <BottomModal onClose={onClose}>
      <Column justifyCenter itemsCenter>
        <Row justifyBetween itemsCenter style={{ height: 20 }} fullX>
          <Text text={t('select_network')} textCenter size="md" />
          <Row
            onClick={() => {
              onClose();
            }}
          >
            <Icon icon="close" size={12} />
          </Row>
        </Row>

        <Row fullX style={{ borderTopWidth: 1, borderColor: colors.border }} mt="md" />

        <Column gap="zero" mt="sm" mb="lg" fullX>
          {CHAIN_GROUPS.map((v, index) => (
            <ChainGroup key={'chain_group_' + index} group={v} onClose={onClose} regtest={regtest} />
          ))}
        </Column>
      </Column>
      {enableRegtestVisible && (
        <RegtestAccessModal onBack={() => setEnableRegtestVisible(false)} onEnabled={switchToRegtestAfterEnable} />
      )}
    </BottomModal>
  );
};
