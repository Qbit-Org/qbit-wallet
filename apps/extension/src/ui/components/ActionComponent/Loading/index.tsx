import { CSSProperties } from 'react';

import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';

import { Spin } from '../../Spin';
import { Text } from '../../Text';
import './index.less';

export interface LoadingProps {
  text?: string;
  onClose?: () => void;
}

// The theme scrim and a surface card in the style of Popover's, so a wait reads
// like the wallet's dialogs.
const $scrimStyle: CSSProperties = {
  width: '100vw',
  height: '100vh',
  backgroundColor: colors.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const $cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: spacing.small,
  maxWidth: 280,
  padding: spacing.large,
  boxSizing: 'border-box',
  backgroundColor: colors.surface,
  border: `1px solid ${colors.border}`,
  boxShadow: `0 24px 54px ${colors.shadow}`
};

export function Loading(props: LoadingProps) {
  const { text } = props;
  return (
    <div className="loading-container">
      <div style={$scrimStyle}>
        <div style={$cardStyle} data-testid="loading-overlay">
          <Spin size="large" />
          {text && <Text text={text} preset="bold" textCenter />}
        </div>
      </div>
    </div>
  );
}
