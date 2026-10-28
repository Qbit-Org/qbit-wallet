import { RotateCw } from 'lucide-react';
import { ReactEventHandler, useState } from 'react';

import { colors } from '@/ui/theme/colors';
import { useI18n } from '@qbit/wallet-state';

import { Row } from '../Row';
import { Text } from '../Text';
import styles from './index.module.less';

export function RefreshButton({
  onClick,
  hideText = false
}: {
  onClick: ReactEventHandler<HTMLDivElement>;
  hideText?: boolean;
}) {
  const [leftTime, setLeftTime] = useState(0);
  const [disabled, setDisabled] = useState(false);
  const [isRotating, setIsRotating] = useState(false);

  const wait = (seconds: number) => {
    if (seconds > 0) {
      setLeftTime(seconds);
      setTimeout(() => {
        wait(seconds - 1);
      }, 1000);
      return;
    }
    setDisabled(false);
  };
  const { t } = useI18n();

  return (
    <Row
      mx="md"
      itemsCenter
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) {
          return;
        }
        setDisabled(true);
        setIsRotating(true);

        setTimeout(() => {
          setIsRotating(false);
        }, 1000);

        wait(5);
        onClick(e);
      }}
      style={{ padding: '6px 8px', margin: '-6px -8px' }}
    >
      <RotateCw className={isRotating ? styles.rotate : ''} size={14} style={{ color: colors.onPrimary }} />
      {!hideText && (
        <Text text={disabled ? `${leftTime} ${t('secs')}` : t('refresh')} color="textDim" size="sm" textCenter />
      )}
    </Row>
  );
}
