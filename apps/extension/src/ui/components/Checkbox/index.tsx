import React from 'react';

import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';

export interface CheckboxChangeEvent {
  target: {
    checked: boolean;
  };
}

export interface CheckboxProps {
  checked?: boolean;
  onChange?: (e: any) => void;
  style?: React.CSSProperties;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}

const BOX_SIZE = 15;
/**
 * Labels are 12–14px text with a normal line height (about 14.5–17px), so
 * nudging the 15px box down by a pixel centres it on the first line of text
 * for the common 14px case while staying within a pixel for 12px labels.
 */
const BOX_TOP_OFFSET = 1;

export function Checkbox(props: CheckboxProps) {
  const { checked = false, onChange, style, disabled = false, children, className, 'data-testid': dataTestId } = props;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;

    onChange?.({
      target: {
        checked: e.target.checked
      }
    });
  };

  return (
    <label
      className={className}
      data-testid={dataTestId}
      style={{
        display: 'inline-flex',
        // Top-aligned so a multi-line label keeps the box on its first line
        // rather than floating beside the middle of the paragraph.
        alignItems: 'flex-start',
        gap: spacing.extraSmall,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        ...style
      }}
    >
      <div
        style={{
          position: 'relative',
          width: `${BOX_SIZE}px`,
          height: `${BOX_SIZE}px`,
          flexShrink: 0,
          marginTop: BOX_TOP_OFFSET
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={handleChange}
          disabled={disabled}
          data-testid={dataTestId ? `${dataTestId}-input` : undefined}
          style={{
            appearance: 'none',
            width: `${BOX_SIZE}px`,
            height: `${BOX_SIZE}px`,
            margin: 0,
            padding: 0,
            boxSizing: 'border-box',
            backgroundColor: checked ? colors.accent : colors.surface,
            border: `1px solid ${checked ? colors.accent : colors.line}`,
            borderRadius: 0,
            cursor: disabled ? 'not-allowed' : 'pointer',
            position: 'absolute',
            top: 0,
            left: 0
          }}
        />
        {checked && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none'
            }}
          >
            <div
              style={{
                width: '9px',
                height: '5px',
                boxSizing: 'border-box',
                borderLeft: `2px solid ${colors.onPrimary}`,
                borderBottom: `2px solid ${colors.onPrimary}`,
                transform: 'rotate(-45deg)'
              }}
            />
          </div>
        )}
      </div>
      {children != null && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            minHeight: `${BOX_SIZE}px`
          }}
        >
          {children}
        </div>
      )}
    </label>
  );
}
