import { useState } from 'react';

import { SwitchChainModal } from '@/ui/pages/Settings/SwitchChainModal';
import { colors } from '@/ui/theme/colors';
import { useChain, useI18n } from '@qbit/wallet-state';

import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { Image } from '../Image';
import { Text } from '../Text';
import { Tooltip } from '../Tooltip';

export function SwitchNetworkBar() {
  const [switchChainModalVisible, setSwitchChainModalVisible] = useState(false);

  const chain = useChain();
  const { t } = useI18n();

  return (
    <>
      <Tooltip
        title={t('switch_network')}
        overlayStyle={{
          minWidth: '70px',
          fontSize: '12px'
        }}
        placement="bottom"
      >
        <Card
          preset="style2"
          data-testid="switch-network-bar"
          onClick={() => {
            setSwitchChainModalVisible(true);
          }}
          style={{
            backgroundColor: colors.surface,
            height: 28,
            borderRadius: 0,
            // Vertical padding matches the style2 wallet pill so all header
            // pills render at the same height.
            padding: '4px 8px',
            gap: 2,
            cursor: 'pointer'
          }}
        >
          <Image src={IMAGE_SOURCE_MAP[chain.icon]} size={18} style={{ marginRight: 2 }} />
          <Text text={chain.iconLabel} color="text" size="xxs" />
          <Icon icon="down" color="textDim" size={10} />
        </Card>
      </Tooltip>
      {/* Rendered outside the clickable card so clicks inside the modal
          (including its close button) cannot bubble into the opener. */}
      {switchChainModalVisible && (
        <SwitchChainModal
          onClose={() => {
            setSwitchChainModalVisible(false);
          }}
        />
      )}
    </>
  );
}
