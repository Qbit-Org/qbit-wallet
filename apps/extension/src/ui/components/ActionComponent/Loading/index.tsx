import { LoaderCircle } from 'lucide-react';
import { CSSProperties } from 'react';

import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';

import { Text } from '../../Text';
import './index.less';

export interface LoadingProps {
  text?: string;
  onClose?: () => void;
}

const $baseViewStyle: CSSProperties = {
  width: '100vw',
  height: '100vh',
  backgroundColor: 'rgba(0,0,0,0.8)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'column',
  gap: spacing.small
};

export function Loading(props: LoadingProps) {
  const { text } = props;
  return (
    <div className="loading-container">
      <div style={$baseViewStyle}>
        <LoaderCircle
          className="icon-spin"
          size={fontSizes.icon}
          style={{
            color: colors.orange
          }}
        />
        {text && <Text text={text} preset="title" color="orange" />}
      </div>
    </div>
  );
}
