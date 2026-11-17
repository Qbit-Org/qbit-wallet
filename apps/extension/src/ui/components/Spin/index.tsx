import React from 'react';

import { colors } from '@/ui/theme/colors';

export interface SpinProps {
  size?: 'small' | 'default' | 'large';
  spinning?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  /** Arc and ring colors; the defaults are for light surfaces. */
  color?: string;
  trackColor?: string;
  'data-testid'?: string;
}

// The wallet's one loading indicator. `size` is the ring's outer diameter
// (border included), and the ring turns through the global `.icon-spin`
// animation (styles/global.less), the same one Button's inline spinner uses.
export function Spin({
  size = 'default',
  spinning = true,
  children,
  style,
  className,
  color = colors.accent,
  trackColor = colors.line,
  'data-testid': dataTestId
}: SpinProps) {
  // Size configurations
  const sizeConfig = {
    small: { size: 16, strokeWidth: 2 },
    default: { size: 20, strokeWidth: 2 },
    large: { size: 32, strokeWidth: 3 }
  };

  const config = sizeConfig[size];

  if (!spinning && children) {
    return <>{children}</>;
  }

  const ring = (
    <div
      className="icon-spin"
      style={{
        boxSizing: 'border-box',
        width: `${config.size}px`,
        height: `${config.size}px`,
        border: `${config.strokeWidth}px solid ${trackColor}`,
        borderTopColor: color,
        borderRadius: '50%'
      }}
    />
  );

  if (children) {
    return (
      <div className={className} style={{ position: 'relative', ...style }} data-testid={dataTestId}>
        <div style={{ opacity: spinning ? 0.5 : 1 }}>{children}</div>
        {spinning && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1000
            }}
          >
            {ring}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style
      }}
      data-testid={dataTestId}
    >
      {ring}
    </div>
  );
}
