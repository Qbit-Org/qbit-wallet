import { useI18n, useTools } from '@qbit/wallet-state';

import { Card } from '../Card';
import { Column } from '../Column';
import { Icon } from '../Icon';
import { Popover } from '../Popover';
import { Row } from '../Row';
import { Text } from '../Text';

export const AddressDetailPopover = ({ address, onClose }: { address: string; onClose: () => void }) => {
  const tools = useTools();
  const { t } = useI18n();
  const isOpReturn = address.startsWith('OP_RETURN');
  const title = isOpReturn ? 'OP_RETURN' : t('full_address');

  const onCopyAddress = () => {
    tools.copyToClipboard(address);
  };

  return (
    <Popover onClose={onClose}>
      <Column>
        <Text text={title} textCenter />
        <Card preset="style2" onClick={onCopyAddress} style={{ backgroundColor: 'var(--qbit-canvas)' }}>
          <Row itemsCenter>
            <Text
              text={address}
              style={{
                overflowWrap: 'anywhere'
              }}
            />
            <Icon icon="copy" />
          </Row>
        </Card>
      </Column>
    </Popover>
  );
};
