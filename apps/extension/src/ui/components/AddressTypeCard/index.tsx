import { ReactEventHandler } from 'react';

import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { numUtils } from '@qbit/base-utils';
import { AddressAssets } from '@qbit/wallet-shared';
import { useChain, useQbitUnit } from '@qbit/wallet-state';

import { Card } from '../Card';
import { Column } from '../Column';
import { CopyableAddress } from '../CopyableAddress';
import { Icon } from '../Icon';
import { Image } from '../Image';
import { Row } from '../Row';
import { Text } from '../Text';

interface AddressTypeCardProps {
  label: string;
  address: string;
  checked: boolean;
  assets: AddressAssets;
  onClick?: ReactEventHandler<HTMLDivElement>;
  'data-testid'?: string;
}
export function AddressTypeCard(props: AddressTypeCardProps) {
  const qbitUnit = useQbitUnit();
  const { onClick, label, address, checked, assets, 'data-testid': dataTestId } = props;
  const hasVault = Boolean(assets.satoshis && assets.satoshis > 0);

  const chain = useChain();
  return (
    <Card px="zero" py="zero" gap="zero" rounded onClick={onClick} data-testid={dataTestId}>
      <Column full>
        <Row justifyBetween px="md" pt="md">
          <Column justifyCenter>
            <Text text={label} size="xs" disableTranslate />
          </Column>
        </Row>
        <Row justifyBetween px="md" pb="md">
          <CopyableAddress address={address} />
          <Column justifyCenter>{checked && <Icon icon="check" />}</Column>
        </Row>
        {hasVault && (
          <Row justifyBetween bg="bg3" roundedBottom px="md" py="md">
            <Row justifyCenter>
              <Image src={IMAGE_SOURCE_MAP[chain.icon]} size={fontSizes.iconMiddle} />
              <Text text={`${assets.totalAmount} ${qbitUnit}`} color="yellow" />
            </Row>
            <Row />
          </Row>
        )}
      </Column>
    </Card>
  );
}

interface AddressTypeCardProp2 {
  label: string;
  items: {
    address: string;
    path: string;
    satoshis: number;
  }[];
  checked: boolean;
  onClick?: ReactEventHandler<HTMLDivElement>;
  'data-testid'?: string;
}

export function AddressTypeCard2(props: AddressTypeCardProp2) {
  const qbitUnit = useQbitUnit();
  const chain = useChain();
  const { onClick, label, items, checked, 'data-testid': dataTestId } = props;
  return (
    <Card px="zero" py="zero" gap={'zero'} rounded onClick={onClick} data-testid={dataTestId}>
      <Column full>
        <Row justifyBetween px="md" pt="md">
          <Column justifyCenter>
            <Text text={label} size="xs" disableTranslate />
          </Column>
          <Column justifyCenter>{checked && <Icon icon="check" />}</Column>
        </Row>

        {items.map((v) => (
          <Column
            px="md"
            pb="sm"
            key={v.address}
            itemsCenter
            style={{
              borderBottomWidth: items.length > 1 ? 1 : 0,
              borderBottomColor: colors.line2
            }}
          >
            <Row fullX>
              <CopyableAddress address={v.address} />
            </Row>
            <Row justifyBetween fullX>
              <Text text={`(${v.path})`} size="xs" color="textDim" disableTranslate />
              {v.satoshis > 0 ? (
                <Row justifyCenter gap="zero" itemsCenter>
                  <Image src={IMAGE_SOURCE_MAP[chain.icon]} size={fontSizes.iconMiddle} />
                  <Text text={`${numUtils.satoshisToAmount(v.satoshis)} ${qbitUnit}`} color="yellow" size="xs" />
                </Row>
              ) : (
                <Row />
              )}
            </Row>
          </Column>
        ))}
      </Column>
    </Card>
  );
}
