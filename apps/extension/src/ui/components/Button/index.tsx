import { LoaderCircle } from 'lucide-react';
import React, { CSSProperties, useState } from 'react';

import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { typography } from '@/ui/theme/typography';

import { Column } from '../Column';
import { Icon, IconTypes } from '../Icon';
import { Row } from '../Row';
import { Text } from '../Text';

type Presets = keyof typeof $viewPresets;
export interface ButtonProps {
  /**
   * The text to display if not using `tx` or nested components.
   */
  text?: string;
  subText?: string;
  /**
   * An optional style override useful for padding & margin.
   */
  style?: CSSProperties;
  /**
   * An optional style override for the "pressed" state.
   */
  pressedStyle?: CSSProperties;
  /**
   * An optional style override for the button text.
   */
  textStyle?: CSSProperties;
  /**
   * An optional style override for the button text when in the "pressed" state.
   */
  pressedTextStyle?: CSSProperties;
  /**
   * One of the different types of button presets.
   */
  preset?: Presets;
  /**
   * An optional component to render on the right side of the text.
   * Example: `RightAccessory={(props) => <View {...props} />}`
   */
  RightAccessory?: React.ReactNode;
  /**
   * An optional component to render on the left side of the text.
   * Example: `LeftAccessory={(props) => <View {...props} />}`
   */
  LeftAccessory?: React.ReactNode;
  /**
   * Children components.
   */
  children?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  icon?: IconTypes;
  iconSize?: {
    width: number;
    height: number;
  };
  disabled?: boolean;
  /**
   * When true the button is disabled and an animated spinner is shown next to the text.
   */
  loading?: boolean;
  full?: boolean;
  max2Lines?: boolean;
}

const $baseViewStyle: CSSProperties = {
  display: 'flex',
  minHeight: 48,
  borderRadius: 0,
  justifyContent: 'center',
  alignItems: 'center',
  flexDirection: 'row',
  overflow: 'hidden',
  cursor: 'pointer',
  alignSelf: 'stretch',
  paddingLeft: spacing.medium,
  paddingRight: spacing.medium,
  transition: 'background-color 150ms ease, border-color 150ms ease, opacity 150ms ease'
};

const $viewPresets = {
  default: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.accent
  }) as CSSProperties,

  primary: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.primary
  } as CSSProperties),

  danger: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.red,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.red
  } as CSSProperties),

  delete: Object.assign({}, $baseViewStyle, {
    backgroundColor: 'rgba(245, 84, 84, 0.10)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#F55454',
    minHeight: 48,
    borderRadius: 0
  } as CSSProperties),

  approval: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.primary
  } as CSSProperties),

  bar: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    height: '75px',
    justifyContent: 'space-between',

    paddingTop: spacing.medium,
    paddingBottom: spacing.medium
  } as CSSProperties),

  defaultV2: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.accent
  } as CSSProperties),

  primaryV2: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.primary
  } as CSSProperties),

  home: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.surface,
    minWidth: 64,
    minHeight: 64,
    flexDirection: 'column',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    boxShadow: `0 8px 24px ${colors.shadow}`,
    padding: 5,
    marginRight: 5,
    marginLeft: 5
  }) as CSSProperties,

  homeGold: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.accentWash,
    minWidth: 64,
    minHeight: 64,
    flexDirection: 'column',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.accent,
    padding: 5,
    marginRight: 5,
    marginLeft: 5
  }) as CSSProperties,

  minimal: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.accentWash,
    minWidth: 60,
    height: 20,
    flexDirection: 'column',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.accent,
    padding: 2,
    marginRight: 5,
    marginLeft: 5,
    alignItems: 'center'
  }) as CSSProperties,

  minimal2: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.primary,
    minWidth: 60,
    height: 20,
    flexDirection: 'column',
    borderRadius: 0,
    borderWidth: 0,
    padding: 2,
    marginRight: 5,
    marginLeft: 5,
    alignItems: 'center'
  }) as CSSProperties,

  swap: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.surfaceMuted,
    minWidth: 60,
    flexDirection: 'column',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    padding: 2,
    marginRight: 5,
    marginLeft: 5,
    alignItems: 'center',
    paddingTop: 7,
    paddingBottom: 7
  }) as CSSProperties
};

const $hoverViewPresets: Record<Presets, CSSProperties> = {
  default: {
    backgroundColor: colors.accentWash,
    borderColor: colors.ink
  },
  primary: {
    backgroundColor: colors.accentHover,
    borderColor: colors.accentHover
  },
  approval: {
    backgroundColor: colors.accentHover,
    borderColor: colors.accentHover
  },
  danger: {
    backgroundColor: colors.red_dark
  },
  delete: {
    backgroundColor: 'rgba(245, 84, 84, 0.15)'
  },
  bar: {
    backgroundColor: colors.accentWash
  },
  defaultV2: {
    backgroundColor: colors.accentWash,
    borderColor: colors.ink
  },
  primaryV2: {
    backgroundColor: colors.accentHover,
    borderColor: colors.accentHover
  },
  home: {
    backgroundColor: colors.accentWash,
    borderColor: colors.accent
  },
  homeGold: {
    backgroundColor: colors.accentWash,
    borderColor: colors.ink
  },
  minimal: {
    backgroundColor: colors.accentWash
  },
  minimal2: {
    backgroundColor: colors.accentHover
  },
  swap: {
    backgroundColor: colors.accentWash
  }
};

const $baseTextStyle: CSSProperties = {
  textAlign: 'center',
  flexShrink: 1,
  flexGrow: 0,
  zIndex: 2,
  color: colors.text,
  fontFamily: typography.mono.bold,
  fontSize: 14,
  lineHeight: 1.2,
  paddingLeft: spacing.tiny,
  paddingRight: spacing.tiny
};

const $textPresets: Record<Presets, CSSProperties> = {
  default: $baseTextStyle,
  primary: Object.assign({}, $baseTextStyle, { color: colors.onPrimary }),
  approval: Object.assign({}, $baseTextStyle, { color: colors.onPrimary }),
  danger: Object.assign({}, $baseTextStyle, { color: colors.onPrimary }),
  delete: Object.assign({}, $baseTextStyle, { color: colors.dangerText }),
  bar: Object.assign({}, $baseTextStyle, { textAlign: 'left', fontWeight: 'bold' } as CSSProperties),

  defaultV2: Object.assign({}, $baseTextStyle, {}),
  primaryV2: Object.assign({}, $baseTextStyle, { color: colors.onPrimary }),
  home: Object.assign({}, $baseTextStyle, {
    color: colors.text,
    fontSize: 12
  }),
  homeGold: Object.assign({}, $baseTextStyle, {
    color: colors.accentDark,
    fontSize: 12
  }),
  minimal: Object.assign({}, $baseTextStyle, {
    color: colors.accentDark,
    fontSize: 12
  }),
  minimal2: Object.assign({}, $baseTextStyle, {
    color: colors.onPrimary,
    fontSize: 12
  }),
  swap: Object.assign({}, $baseTextStyle, {
    color: colors.textDim,
    fontSize: 12
  })
};

const $rightAccessoryStyle: CSSProperties = { marginLeft: spacing.extraSmall, zIndex: 1 };
const $leftAccessoryStyle: CSSProperties = { marginRight: spacing.extraSmall, zIndex: 1 };
const $baseDisabledViewStyle: CSSProperties = { cursor: 'not-allowed', opacity: 0.45 };
export function Button(props: ButtonProps) {
  const {
    text,
    subText,
    style: $viewStyleOverride,
    pressedStyle: $pressedViewStyleOverride,
    textStyle: $textStyleOverride,
    pressedTextStyle: $pressedTextStyleOverride,
    children,
    RightAccessory,
    LeftAccessory,
    onClick,
    icon,
    iconSize,
    disabled,
    loading,
    full,
    max2Lines,
    ...rest
  } = props;

  const preset: Presets = props.preset || 'default';
  const [hover, setHover] = useState(false);
  const isDisabled = disabled || loading;
  const $viewStyle = Object.assign(
    {},
    $viewPresets[preset],
    $viewStyleOverride,
    hover && !isDisabled ? $hoverViewPresets[preset] : {},
    isDisabled ? $baseDisabledViewStyle : {},
    full ? { flex: 1 } : {}
  );
  const $textStyle = Object.assign(
    {},
    $textPresets[preset],
    $textStyleOverride,
    hover && !isDisabled && preset === 'danger' ? { color: colors.onDanger } : {}
  );

  const $subTextStyle = Object.assign({}, $textPresets[preset], {
    color: colors.textDim,
    marginTop: 5,
    fontWeight: 'normal'
  } as CSSProperties);
  const loadingSpinner = loading ? (
    <LoaderCircle className="icon-spin" size="1em" style={{ color: $textStyle.color, flexShrink: 0 }} />
  ) : null;
  if (preset === 'bar') {
    return (
      <div
        style={$viewStyle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={isDisabled ? undefined : onClick}
        {...rest}
      >
        <Row>
          {LeftAccessory && <div style={$leftAccessoryStyle}>{LeftAccessory}</div>}
          {icon && <Icon icon={icon} color="text" style={{ marginRight: spacing.tiny }} />}
          {loadingSpinner}
          <Column justifyCenter gap="zero">
            {text && <Text text={text} style={$textStyle} />}
            {subText && <Text text={subText} style={$subTextStyle} />}
          </Column>

          {children}
        </Row>

        {RightAccessory && <div style={$rightAccessoryStyle}>{RightAccessory}</div>}
      </div>
    );
  }

  if (preset === 'home' || preset === 'homeGold') {
    if (isDisabled) {
      $viewStyle.backgroundColor = colors.surfaceMuted;
    }
    const $textStyle = Object.assign({}, $textPresets[preset], $textStyleOverride);
    return (
      <div
        style={$viewStyle}
        onClick={isDisabled ? undefined : onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        {...rest}
      >
        {icon && (
          <Icon
            icon={icon}
            style={Object.assign(
              { backgroundColor: $textPresets[preset].color || colors.white },
              iconSize ? iconSize : {}
            )}
            containerStyle={iconSize ? iconSize : {}}
          />
        )}
        {loadingSpinner}
        {text && <Text style={$textStyle} text={text} preset="regular" mt="sm" max2Lines={max2Lines} />}
      </div>
    );
  }

  if (preset === 'swap') {
    if (isDisabled) {
      $viewStyle.backgroundColor = colors.surfaceMuted;
    }
    const $textStyle = Object.assign({}, $textPresets[preset], $textStyleOverride);
    return (
      <div
        style={$viewStyle}
        onClick={isDisabled ? undefined : onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        {...rest}
      >
        {icon && (
          <Icon
            icon={icon}
            style={Object.assign(
              { backgroundColor: $textPresets[preset].color || colors.white },
              iconSize ? iconSize : {}
            )}
            containerStyle={iconSize ? iconSize : {}}
          />
        )}
        {loadingSpinner}
        {text && <Text style={$textStyle} text={text} preset="regular" />}
      </div>
    );
  }

  if (preset === 'minimal' || preset === 'minimal2') {
    return (
      <div
        style={$viewStyle}
        onClick={isDisabled ? undefined : onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        {...rest}
      >
        {loadingSpinner}
        {text && <Text style={$textStyle} text={text} preset="regular" />}
      </div>
    );
  }

  return (
    <div
      style={$viewStyle}
      onClick={isDisabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
    >
      {LeftAccessory && <div style={$leftAccessoryStyle}>{LeftAccessory}</div>}
      {icon && <Icon icon={icon} style={{ marginRight: spacing.tiny, backgroundColor: $textStyle.color }} />}
      {loadingSpinner}
      {text && <Text style={$textStyle} text={text} preset="regular-bold" />}
      {children}
      {RightAccessory && <div style={$rightAccessoryStyle}>{RightAccessory}</div>}
    </div>
  );
}
