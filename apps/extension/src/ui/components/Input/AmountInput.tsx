import { useEffect, useRef, useState } from 'react';

import { Icon, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { useI18n } from '@qbit/wallet-state';

import { $baseContainerStyle, $baseInputStyle, InputProps } from '.';
import { Column } from '../Column';

export function AmountInput(props: InputProps) {
  const {
    placeholder,
    onAmountInputChange,
    disabled,
    style: $inputStyleOverride,
    disableDecimal,
    containerStyle,
    decimalPlaces,
    enableMax,
    onMaxClick,
    enableStepper,
    step = 0.01,
    min = 0.01,
    ...rest
  } = props;
  const hasTrailingControl = enableMax || enableStepper;
  const $style = Object.assign(
    {},
    $baseInputStyle,
    hasTrailingControl ? { padding: `${spacing.extraSmall}px 0 ${spacing.extraSmall}px ${spacing.medium}px` } : {},
    $inputStyleOverride,
    disabled ? { color: colors.textDim } : {}
  );
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState(props.value || '');
  const [validAmount, setValidAmount] = useState(props.value || '');
  useEffect(() => {
    if (onAmountInputChange) {
      onAmountInputChange(validAmount);
    }
  }, [validAmount]);

  const propValueRef = useRef(props.value);
  useEffect(() => {
    if (props.value !== propValueRef.current) {
      propValueRef.current = props.value;
      const nextValue = props.value || '';
      setInputValue(nextValue);
      setValidAmount(nextValue);
    }
  }, [props.value]);

  if (!onAmountInputChange) {
    return <div />;
  }

  const handleInputAmount = (e) => {
    const value = e.target.value;
    if (disableDecimal) {
      if (/^[1-9]\d*$/.test(value) || value === '') {
        setValidAmount(value);
        setInputValue(value);
      }
    } else {
      if (decimalPlaces !== undefined) {
        const regex = new RegExp(`^(0(\\.\\d{0,${decimalPlaces}})?|[1-9]\\d*\\.?\\d{0,${decimalPlaces}})$`);
        if (regex.test(value) || value === '') {
          setValidAmount(value);
          setInputValue(value);
        }
      } else {
        if (/^(0(\.\d{0,8})?|[1-9]\d*\.?\d{0,8})$/.test(value) || value === '') {
          setValidAmount(value);
          setInputValue(value);
        }
      }
    }
  };

  const handleStepUp = () => {
    const currentVal = parseFloat(props.value!) || 0;
    const decimal = decimalPlaces !== undefined ? decimalPlaces : 2;
    const newVal = (currentVal + step).toFixed(decimal);
    setValidAmount(newVal);
    setInputValue(newVal);
  };

  const handleStepDown = () => {
    const currentVal = parseFloat(props.value!) || 0;
    const decimal = decimalPlaces !== undefined ? decimalPlaces : 2;
    const newVal = Math.max(min, currentVal - step).toFixed(decimal);
    setValidAmount(newVal);
    setInputValue(newVal);
  };

  return (
    <div style={Object.assign({}, $baseContainerStyle, containerStyle)}>
      <input
        placeholder={placeholder || ''}
        type={'text'}
        value={inputValue}
        onChange={handleInputAmount}
        style={$style}
        disabled={disabled}
        {...rest}
      />
      {enableMax ? (
        <Text
          onClick={() => {
            if (onMaxClick) onMaxClick();
          }}
          text={t('max')}
          color={'yellow'}
          size="sm"
          style={{ marginRight: enableStepper ? 0 : spacing.extraSmall }}
        />
      ) : null}
      {enableStepper && (
        <Column gap="zero" style={{ marginLeft: spacing.small, marginRight: spacing.extraSmall }}>
          <Icon
            icon="up"
            size={12}
            style={{
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              padding: 2
            }}
            onClick={disabled ? undefined : handleStepUp}
          />
          <Icon
            icon="down"
            size={12}
            style={{
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              padding: 2
            }}
            onClick={disabled ? undefined : handleStepDown}
          />
        </Column>
      )}
    </div>
  );
}
