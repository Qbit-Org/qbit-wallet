import { Card, Icon, Row, Text } from '@/ui/components';
import { fontSizes } from '@/ui/theme/font';
import { useAddressTypeSettingLogic } from '@qbit/wallet-state';

/**
 * Advanced-settings entry for the current wallet's address type, in the
 * Language row's look: the label, the type by name (with the HD path and the
 * account index where the wallet shows one) and a chevron into the Address
 * Type screen. A value too long for the line wraps under itself.
 */
export function AddressTypeSettingCard() {
  const { label, value, onClick } = useAddressTypeSettingLogic();

  return (
    <Card style={{ borderRadius: 0, cursor: 'pointer' }} onClick={onClick} data-testid="advanced-address-type-row">
      <Row full justifyBetween itemsCenter>
        <Text text={label} preset="bold" size="sm" style={{ flexShrink: 0 }} />
        <Row itemsCenter gap="xs" style={{ minWidth: 0 }}>
          <Text text={value} size="sm" color="textDim" textEnd wrap data-testid="advanced-address-type-value" />
          <Icon icon="right" size={fontSizes.lg} color="textDim" containerStyle={{ flexShrink: 0 }} />
        </Row>
      </Row>
    </Card>
  );
}
