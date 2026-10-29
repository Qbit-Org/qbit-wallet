import { CSSProperties, ReactNode } from 'react';

import { colors } from '@/ui/theme/colors';
import { useFeeRateBarLogic, useI18n } from '@qbit/wallet-state';

import { Column } from '../Column';
import { Input } from '../Input';
import { Row } from '../Row';
import { Text } from '../Text';
import { FeeRateType } from './const';

export function FeeRateBar({
  readonly,
  quote,
  headerRight
}: Parameters<typeof useFeeRateBarLogic>[0] & { headerRight?: ReactNode }) {
  const {
    feeOptions,
    feeOptionIndex,
    setFeeOptionIndex,
    isSpecialLocale,
    isCustomOption,
    fontSize,
    feeRateInputVal,
    adjustFeeRateInput,
    showCustomInput,
    toggleCustomInput,
    supportLowFeeMode,
    feeEstimateUnavailable,
    fallbackFeeRate
  } = useFeeRateBarLogic({
    readonly,
    quote
  });

  const { t } = useI18n();

  return (
    <Column>
      <Row justifyBetween itemsCenter fullX>
        <Text text={t('network_fee_2')} />
        {headerRight}
      </Row>

      <Row justifyCenter>
        {feeOptions.map((v, position) => {
          // The option a tile selects: Custom wherever it stands, a tier by its position.
          const index = isCustomOption(v) ? FeeRateType.CUSTOM : position;
          let selected = index === feeOptionIndex;
          if (readonly) {
            selected = false;
          }

          return (
            <div
              key={v.title}
              onClick={() => {
                if (readonly) {
                  return;
                }
                setFeeOptionIndex(index);
                if (index === feeOptionIndex && !isCustomOption(v)) {
                  toggleCustomInput(!showCustomInput);
                }
              }}
              style={Object.assign(
                {},
                {
                  border: `1px solid ${colors.border}`,
                  backgroundColor: colors.surface,
                  height: 75,
                  width: 75,
                  textAlign: 'center',
                  padding: 4,
                  borderRadius: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  cursor: 'pointer'
                } as CSSProperties,
                selected ? { border: `1px solid ${colors.accent}`, backgroundColor: colors.accentWash } : {}
              )}
              data-selected={selected}
              data-testid={`fee-rate-option-${index}`}
            >
              <Text
                text={v.title}
                textCenter
                style={{
                  color: selected ? colors.accentDark : colors.text,
                  fontSize: isSpecialLocale ? (isCustomOption(v) ? '7px' : '12px') : '14px'
                }}
              />
              {!isCustomOption(v) && (
                <Text
                  text={`${v.feeRate} bits/vB`}
                  size={fontSize as any}
                  textCenter
                  style={{ color: selected ? colors.accentDark : colors.text }}
                />
              )}
              {!isCustomOption(v) && (
                <Text
                  text={`${v.desc}`}
                  size={fontSize as any}
                  textCenter
                  style={{ color: selected ? colors.accentDark : colors.textDim }}
                />
              )}
            </div>
          );
        })}
      </Row>

      {feeEstimateUnavailable ? (
        <Text
          text={t('fee_estimates_unavailable_using_floor', [String(fallbackFeeRate)])}
          size="xs"
          color="warning"
          data-testid="fee-estimates-unavailable"
        />
      ) : null}

      {showCustomInput && (
        <Input
          preset="amount"
          placeholder={'bits/vB'}
          value={feeRateInputVal}
          decimalPlaces={2}
          onAmountInputChange={(amount) => {
            adjustFeeRateInput(amount);
          }}
          autoFocus={true}
          enableStepper={true}
          step={0.01}
          min={supportLowFeeMode ? 0.1 : 1}
        />
      )}
    </Column>
  );
}
