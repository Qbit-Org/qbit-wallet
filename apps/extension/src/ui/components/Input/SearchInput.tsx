import { ArrowRight, Search } from 'lucide-react';
import { Row } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';

import { $baseContainerStyle, $baseInputStyle, InputProps } from '.';

export function SearchInput(props: InputProps) {
  const { placeholder, containerStyle, style: $inputStyleOverride, disabled, autoFocus, onSearch, ...rest } = props;
  return (
    <Row
      style={Object.assign(
        {},
        $baseContainerStyle,
        {
          backgroundColor: colors.surface,
          border: `1px solid ${colors.line}`,
          borderRadius: 0,
          padding: 0,
          gap: 0,
          alignSelf: 'stretch'
        },
        containerStyle
      )}
    >
      <Row full itemsCenter style={{ gap: 0 }}>
        <Search size="1em" style={{ color: colors.textDim, marginLeft: spacing.medium }} />
        <input
          placeholder={placeholder}
          type={'text'}
          disabled={disabled}
          autoFocus={autoFocus}
          style={Object.assign(
            {},
            $baseInputStyle,
            { paddingLeft: spacing.extraSmall },
            $inputStyleOverride,
            disabled ? { color: colors.textDim } : {}
          )}
          {...rest}
        />
      </Row>
      <Row
        onClick={onSearch}
        itemsCenter
        justifyCenter
        clickable={Boolean(onSearch)}
        style={{
          cursor: onSearch ? 'pointer' : 'default',
          alignSelf: 'stretch',
          width: 40,
          flexShrink: 0,
          borderLeft: `1px solid ${colors.line}`
        }}
      >
        <ArrowRight size="1em" style={{ color: onSearch ? colors.accentDark : colors.textDim }} />
      </Row>
    </Row>
  );
}
