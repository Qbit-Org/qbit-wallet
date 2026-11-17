import React from 'react';

import { colors } from '@/ui/theme/colors';

import './index.less';

export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'small' | 'default';
  style?: React.CSSProperties;
  className?: string;
  /** The switch's name for assistive technology, such as the label of its row. */
  'aria-label'?: string;
  /** Or the id of the element on screen whose text names it. */
  'aria-labelledby'?: string;
}

/**
 * An on/off switch. Assistive technology reads it as a switch, with its name
 * and state; it takes keyboard focus in order, and Space or Enter toggles it,
 * as a click does. A disabled switch keeps its focus and does nothing.
 */
export function Switch({
  checked = false,
  onChange,
  disabled = false,
  size = 'default',
  style,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy
}: SwitchProps) {
  const handleClick = () => {
    if (disabled) return;
    onChange?.(!checked);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    // Space would scroll the page.
    event.preventDefault();
    // A held key toggles once.
    if (event.repeat) return;
    handleClick();
  };

  // Size configurations
  const sizeConfig = {
    small: { width: 28, height: 16, dotSize: 12 },
    default: { width: 44, height: 22, dotSize: 18 }
  };

  const config = sizeConfig[size];

  return (
    <div
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      tabIndex={0}
      className={className ? `qbit-switch ${className}` : 'qbit-switch'}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{
        width: `${config.width}px`,
        height: `${config.height}px`,
        backgroundColor: checked ? colors.accent : '#B8C7BE',
        borderRadius: `${config.height / 2}px`,
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background-color 0.3s ease',
        ...style
      }}
    >
      <div
        style={{
          width: `${config.dotSize}px`,
          height: `${config.dotSize}px`,
          backgroundColor: colors.surface,
          borderRadius: '50%',
          position: 'absolute',
          top: '50%',
          left: checked ? `${config.width - config.dotSize - 2}px` : '2px',
          transform: 'translateY(-50%)',
          transition: 'left 0.3s ease',
          boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
        }}
      />
    </div>
  );
}

export function Skeleton(props: any) {
  return <div />;
}
