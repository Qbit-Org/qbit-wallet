import { useState } from 'react';

import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { Card, Column, Icon, Image, Row, Text } from '@/ui/components';
import { BottomModal } from '@/ui/components/BottomModal';
import { colors } from '@/ui/theme/colors';
import { CHAIN_GROUPS, CHAINS_MAP, TypeChainGroup } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';

function ChainItem(props: {
  chainType: ChainType;
  inGroup?: boolean;
  onClose: () => void;
  onSelect: (chainType: ChainType) => void;
  selectedChainType: ChainType | null;
}) {
  const chain = CHAINS_MAP[props.chainType];
  const selected = props.selectedChainType === props.chainType;

  return (
    <Card
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
      onClick={() => {
        if (chain.disable) {
          return;
        }
        props.onSelect(props.chainType);
        props.onClose();
      }}
    >
      <Row fullX justifyBetween itemsCenter>
        <Row itemsCenter>
          <Image src={IMAGE_SOURCE_MAP[chain.icon]} size={30} style={{ opacity: chain.disable ? 0.7 : 1 }} />
          <Text text={chain.label} color={chain.disable ? 'textDim' : 'text'} />
        </Row>
      </Row>
    </Card>
  );
}

function ChainGroup(props: {
  group: TypeChainGroup;
  onClose: () => void;
  onSelect: (chainType: ChainType) => void;
  selectedChainType: ChainType | null;
}) {
  const group = props.group;
  const [folded, setFolded] = useState(true);

  if (group.type === 'single') {
    return (
      <ChainItem
        chainType={group.chain!.enum}
        onClose={props.onClose}
        onSelect={props.onSelect}
        selectedChainType={props.selectedChainType}
      />
    );
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
                      onSelect={props.onSelect}
                      selectedChainType={props.selectedChainType}
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

export const ContactChainModal = ({
  onClose,
  onSelect,
  selectedChainType,
  hideAllNetworks = false
}: {
  onClose: () => void;
  onSelect: (chainType: ChainType) => void;
  selectedChainType: ChainType | null;
  hideAllNetworks?: boolean;
}) => {
  const { t } = useI18n();
  const handleSelectAll = () => {
    onSelect(null as any);
    onClose();
  };

  const handleSelectNetwork = (chainType: ChainType) => {
    onSelect(chainType);
    onClose();
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
          {/* All Networks Option */}
          {!hideAllNetworks && (
            <Card
              style={{
                borderRadius: 0,
                borderColor: colors.gold,
                borderWidth: selectedChainType === null ? 1 : 0,
                backgroundColor: colors.surface,
                marginTop: 12
              }}
              onClick={handleSelectAll}
            >
              <Row fullX justifyBetween itemsCenter>
                <Row itemsCenter>
                  <Image src={IMAGE_SOURCE_MAP['testnet-all']} size={30} />
                  <Text text={t('all_networks')} color="text" />
                </Row>
              </Row>
            </Card>
          )}

          {CHAIN_GROUPS.map((v, index) => (
            <ChainGroup
              key={'chain_group_' + index}
              group={v}
              onClose={onClose}
              onSelect={handleSelectNetwork}
              selectedChainType={selectedChainType}
            />
          ))}
        </Column>
      </Column>
    </BottomModal>
  );
};
