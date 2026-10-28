import type { CSSProperties } from 'react';

import type { Gap } from '@/ui/theme/spacing';
import { useI18n } from '@qbit/wallet-state';

import { Icon } from '../Icon';
import { Row } from '../Row';
import { Text } from '../Text';

export function ViewOnExplorerAction({
  onClick,
  mt,
  style
}: {
  onClick: (e?: any) => void;
  mt?: Gap;
  style?: CSSProperties;
}) {
  const { t } = useI18n();

  return (
    <Row
      justifyCenter
      itemsCenter
      clickable
      onClick={onClick}
      mt={mt}
      style={{
        minHeight: 40,
        borderRadius: 0,
        backgroundColor: 'var(--qbit-accent-wash)',
        border: '1px solid var(--qbit-line)',
        gap: 10,
        ...style
      }}
    >
      <Text text={t('view_on_block_explorer')} size="sm" style={{ color: 'var(--qbit-accent-dark)' }} />
      <Icon icon="right" size={12} color="textDim" />
    </Row>
  );
}
