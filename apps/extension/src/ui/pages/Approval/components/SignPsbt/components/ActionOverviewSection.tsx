import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { Card, Column, Icon, Image, Row, Text } from '@/ui/components';
import { AddressText } from '@/ui/components/AddressText';
import { colors } from '@/ui/theme/colors';
import { shortAddress } from '@/ui/utils';
import { numUtils } from '@qbit/base-utils';
import { PsbtActionDetail, PsbtActionDetailType } from '@qbit/wallet-shared';
import { ActionOverviewSectionProps, useActionOverviewSectionLogic, useQbitUnit } from '@qbit/wallet-state';

function DetailItemRow({ detail }: { detail: PsbtActionDetail }) {
  const qbitUnit = useQbitUnit();
  const LabelCom = (
    <Text
      text={detail.label}
      preset="regular"
      color="textDim"
      size="sm"
      style={{
        maxWidth: 100
      }}
    />
  );
  try {
    if (detail.type === PsbtActionDetailType.ADDRESS) {
      return (
        <Row justifyBetween itemsCenter data-testid="psbt-action-detail">
          {LabelCom}
          <AddressText
            address={detail.value.toString()}
            color={detail.warning ? 'warning' : 'accentDark'}
            bold
            showEye
          />
        </Row>
      );
    } else if (detail.type === PsbtActionDetailType.SATOSHIS) {
      return (
        <Row justifyBetween data-testid="psbt-action-detail">
          {LabelCom}
          <Row>
            <Text
              text={`${numUtils.satoshisToAmount(detail.value as number)} ${qbitUnit}`}
              preset="bold"
              color={detail.warning ? 'warning' : detail.highlight ? 'accentDark' : 'text'}
              size="sm"
              style={{ maxWidth: 250, textAlign: 'right' }}
            />
          </Row>
        </Row>
      );
    } else {
      return (
        <Row justifyBetween data-testid="psbt-action-detail">
          {LabelCom}
          <Row>
            <Text
              text={shortAddress(detail.value.toString(), 12)}
              preset={detail.highlight ? 'bold' : 'regular'}
              color={detail.warning ? 'warning' : detail.highlight ? 'accentDark' : 'text'}
              size="sm"
              style={{ maxWidth: 250, textAlign: 'right' }}
            />
          </Row>
        </Row>
      );
    }
  } catch (e) {
    console.error('DetailItemRow render error:', e);
    return null;
  }
}

export default function ActionOverviewSection(props: ActionOverviewSectionProps) {
  const { action, chain, commonDetails } = useActionOverviewSectionLogic(props);
  return (
    <Card data-testid="psbt-action-overview">
      <Column gap="lg" fullX>
        <Row itemsCenter gap="md" justifyBetween>
          {action.icon && <Icon icon={action.icon as any} size={20} color="accentDark" />}
          <Text
            text={action.name}
            preset="title-bold"
            size="md"
            color="accentDark"
            style={{
              maxWidth: 200
            }}
            data-testid="psbt-action-title"
          />

          <Row itemsCenter>
            <Image src={IMAGE_SOURCE_MAP[chain.icon]} size={16} />
            <Text text={chain.iconLabel} />
          </Row>
        </Row>

        {action.description && <Text text={action.description} preset="regular" color="text" wrap />}

        {action.details && action.details.length > 0 && (
          <Row
            style={{
              borderBottomWidth: 1,
              borderBottomColor: colors.border
            }}
          ></Row>
        )}

        {action.details && action.details.length > 0 && (
          <Column gap="sm" fullX>
            {action.details.map((detail, index) => (
              <DetailItemRow key={index} detail={detail} />
            ))}
          </Column>
        )}

        {commonDetails.length > 0 && (
          <Row
            style={{
              borderBottomWidth: 1,
              borderBottomColor: colors.border
            }}
          ></Row>
        )}
        {commonDetails.map((detail, index) => (
          <DetailItemRow key={index} detail={detail} />
        ))}
      </Column>
    </Card>
  );
}
