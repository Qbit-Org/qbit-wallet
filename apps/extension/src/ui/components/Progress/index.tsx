import React from 'react';

import { colors } from '@/ui/theme/colors';

export interface ProgressProps {
  percent?: number;
  showInfo?: boolean;
  size?: 'small' | 'default' | 'large';
  strokeColor?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
  className?: string;
  /** Names the bar for screen readers and makes it a progressbar to them; without it the bar is decoration. */
  ariaLabel?: string;
  /** Text screen readers read for the value instead of the percentage. */
  ariaValueText?: string;
  'data-testid'?: string;
}

export function Progress({
  percent = 0,
  showInfo = true,
  size = 'default',
  strokeColor = colors.accent,
  strokeWidth,
  style,
  className,
  ariaLabel,
  ariaValueText,
  'data-testid': testId
}: ProgressProps) {
  // Size configurations
  const sizeConfig = {
    small: { height: 6, fontSize: 12 },
    default: { height: 8, fontSize: 14 },
    large: { height: 10, fontSize: 16 }
  };

  const config = sizeConfig[size];
  const height = strokeWidth || config.height;
  const clampedPercent = Math.min(Math.max(percent, 0), 100);

  return (
    <div
      className={className}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        ...style
      }}
    >
      <div
        {...(ariaLabel
          ? {
              role: 'progressbar',
              'aria-label': ariaLabel,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(clampedPercent),
              'aria-valuetext': ariaValueText
            }
          : {})}
        data-testid={testId}
        style={{
          flex: 1,
          height: `${height}px`,
          backgroundColor: colors.line,
          borderRadius: `${height / 2}px`,
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${clampedPercent}%`,
            backgroundColor: strokeColor,
            borderRadius: `${height / 2}px`,
            transition: 'width 0.3s ease',
            position: 'absolute',
            left: 0,
            top: 0
          }}
        />
      </div>
      {showInfo && (
        <span
          style={{
            fontSize: `${config.fontSize}px`,
            color: colors.text,
            minWidth: '36px',
            textAlign: 'right'
          }}
        >
          {Math.round(clampedPercent)}%
        </span>
      )}
    </div>
  );
}
