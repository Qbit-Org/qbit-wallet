import React from 'react';

import { colors } from '@/ui/theme/colors';
import { Icon } from '../Icon';
import { Row } from '../Row';

export const Popover = (props: {
  children: React.ReactNode;
  onClose?: () => void;
  contentStyle?: React.CSSProperties;
  'data-testid'?: string;
}) => {
  const { children, onClose, contentStyle, 'data-testid': dataTestId, ...rest } = props;
  return (
    <div
      className="popover-container"
      style={{
        backgroundColor: colors.overlay
      }}
    >
      <div
        style={{
          backgroundColor: colors.surface,
          width: 340,
          // Auto margins center the card while it fits and collapse to zero
          // when it outgrows the overlay, keeping both edges scrollable.
          margin: 'auto',
          padding: 20,
          borderRadius: 0,
          border: `1px solid ${colors.border}`,
          boxShadow: `0 24px 54px rgba(7, 17, 11, 0.14)`,
          position: 'relative',
          ...contentStyle
        }}
        data-testid={dataTestId}
      >
        {onClose && (
          <Row
            style={{ position: 'absolute', top: 20, right: 20 }}
            justifyEnd
            onClick={() => {
              onClose();
            }}
            data-testid="popover-close"
          >
            <Icon icon="close" size={12} />
          </Row>
        )}

        {children}
      </div>
    </div>
  );
};
