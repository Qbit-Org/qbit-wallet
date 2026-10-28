import React, { CSSProperties } from 'react';

import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { typography } from '@/ui/theme/typography';
import { ChainType } from '@qbit/wallet-types';

import { $textPresets } from '../Text';
import { AddressInput } from './AddressInput';
import { AmountInput } from './AmountInput';
import { PasswordInput } from './PasswordInput';
import { SearchInput } from './SearchInput';
import { TextInput } from './TextInput';

export interface InputProps {
  preset?: Presets;
  placeholder?: string;
  children?: React.ReactNode;
  onChange?: React.ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onKeyUp?: React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onFocus?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onPaste?: React.ClipboardEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  autoFocus?: boolean;
  defaultValue?: string;
  value?: string;
  style?: CSSProperties;
  containerStyle?: CSSProperties;
  addressInputData?: { address: string };
  onAddressInputChange?: (params: { address: string }) => void;
  onAmountInputChange?: (amount: string) => void;
  disabled?: boolean;
  disableDecimal?: boolean;
  decimalPlaces?: number;
  enableMax?: boolean;
  onMaxClick?: () => void;
  onSearch?: () => void;
  recipientLabel?: React.ReactNode;
  networkType?: ChainType;
  addressPlaceholder?: string;
  maxLength?: number;
  enableStepper?: boolean;
  step?: number;
  min?: number;
}

type Presets = keyof typeof $inputPresets;
const $inputPresets = {
  password: {},
  amount: {},
  address: {},
  text: {},
  search: {}
};

export const $baseContainerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  backgroundColor: colors.surface,
  padding: 0,
  borderRadius: 0,
  alignSelf: 'stretch',
  border: `1px solid ${colors.line}`,
  boxShadow: `0 1px 0 ${colors.shadow}`
};

export const $baseInputStyle: CSSProperties = Object.assign({}, $textPresets.regular, {
  display: 'flex',
  flex: 1,
  borderWidth: 0,
  outlineWidth: 0,
  backgroundColor: 'rgba(0,0,0,0)',
  alignSelf: 'stretch',
  color: colors.text,
  caretColor: colors.accent,
  fontFamily: typography.primary.regular,
  fontSize: 14,
  lineHeight: '22px',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: `${spacing.extraSmall}px ${spacing.medium}px`,
  userSelect: 'text'
});

export const $baseTextareaStyle: CSSProperties = Object.assign({}, $baseInputStyle, {
  overflowWrap: 'break-word',
  wordWrap: 'break-word',
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
  resize: 'none',
  border: 'none',
  height: 'auto',
  minHeight: '22px',
  background: 'transparent',
  lineHeight: '22px'
});

export function Input(props: InputProps) {
  const { preset } = props;

  if (preset === 'password') {
    return <PasswordInput {...props} />;
  } else if (preset === 'amount') {
    return <AmountInput {...props} />;
  } else if (preset === 'address') {
    return <AddressInput {...props} />;
  } else if (preset === 'search') {
    return <SearchInput {...props} />;
  } else {
    return <TextInput {...props} />;
  }
}
