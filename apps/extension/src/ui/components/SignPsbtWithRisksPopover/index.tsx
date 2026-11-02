import { useEffect, useMemo, useState } from 'react';

import { colors } from '@/ui/theme/colors';
import { DecodedPsbt, QbitFeeAssessment, Risk, RiskType } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

import { Button } from '../Button';
import { Column } from '../Column';
import { Icon } from '../Icon';
import { Input } from '../Input';
import { Popover } from '../Popover';
import { Row } from '../Row';
import { Text } from '../Text';
import { BadFeeRate } from './BadFeeRate';

const visibleRiskDetailTypes = [RiskType.LOW_FEE_RATE, RiskType.HIGH_FEE_RATE];

/**
 * The title and description keys of a risk. A high fee that only its share of
 * the amount flagged, at a rate that is not high, is named a high fee.
 */
export function getRiskContentKey(riskType: RiskType, feeAssessment?: QbitFeeAssessment) {
  switch (riskType) {
    case RiskType.SIGHASH_NONE:
      return {
        title: 'sighash_none_risk_title',
        description: 'sighash_none_risk_description'
      };
    case RiskType.SCAMMER_ADDRESS:
      return {
        title: 'scammer_address_risk_title',
        description: 'scammer_address_risk_description'
      };
    case RiskType.NETWORK_NOT_MATCHED:
      return {
        title: 'network_not_matched_risk_title',
        description: 'network_not_matched_risk_description'
      };
    case RiskType.HIGH_FEE_RATE:
      if (feeAssessment?.highFeeAtNormalRate) {
        return {
          title: 'high_fee_risk_title',
          description: 'high_fee_risk_description'
        };
      }
      return {
        title: 'high_fee_rate_risk_title',
        description: 'high_fee_rate_risk_description'
      };
    case RiskType.UNRECOGNISED_OUTPUT:
      return {
        title: 'unrecognised_output_risk_title',
        description: 'unrecognised_output_risk_description'
      };
    default:
      return {
        title: 'unknown_risk_title',
        description: 'unknown_risk_description'
      };
  }
}

export const SignPsbtWithRisksPopover = ({
  decodedPsbt,
  onConfirm,
  onClose
}: {
  decodedPsbt: DecodedPsbt;
  onConfirm: () => void;
  onClose: () => void;
}) => {
  const [inputValue, setInputValue] = useState('');
  const [understand, setUnderstand] = useState(false);
  const { t } = useI18n();
  const AGREEMENT_TEXT = 'CONFIRM';

  useEffect(() => {
    if (inputValue.toUpperCase() === AGREEMENT_TEXT) {
      setUnderstand(true);
    } else {
      setUnderstand(false);
    }
  }, [inputValue]);

  const [detailRisk, setDetailRisk] = useState<Risk | null>();

  const confirmable = useMemo(() => {
    const foundCriticalRisk = decodedPsbt.risks.find((v) => v.level === 'critical');
    if (foundCriticalRisk) {
      return false;
    } else {
      return true;
    }
  }, [decodedPsbt]);

  if (detailRisk) {
    if (detailRisk.type === RiskType.LOW_FEE_RATE || detailRisk.type === RiskType.HIGH_FEE_RATE) {
      const riskContentKey = getRiskContentKey(detailRisk.type, decodedPsbt.spendSummary?.feeAssessment);
      return (
        <BadFeeRate decodedPsbt={decodedPsbt} riskContentKey={riskContentKey} onClose={() => setDetailRisk(null)} />
      );
    }
  }

  return (
    <Popover>
      <Column justifyCenter itemsCenter>
        <Icon icon={'alert'} color={'dangerText'} size={20} />
        <Text text={t('use_at_your_own_risk')} preset="title-bold" />
        <Text text={t('please_be_aware_that_sending_the_following_assets_involves_risk')} preset="sub" />

        <Column gap="md" fullX mb="md">
          {decodedPsbt.risks.map((risk, index) => {
            const riskContentKey = getRiskContentKey(risk.type, decodedPsbt.spendSummary?.feeAssessment);
            const title = riskContentKey.title ? t(riskContentKey.title) : risk.title;
            const desc = riskContentKey.description ? t(riskContentKey.description) : risk.desc;
            return (
              <Column
                key={'risk_' + index}
                style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 0 }}
                px="md"
                py="sm"
              >
                <Row justifyBetween justifyCenter mt="sm">
                  <Text text={title} color={risk.level === 'warning' ? 'warning' : 'dangerText'} />
                  {visibleRiskDetailTypes.includes(risk.type) ? (
                    <Text
                      text={t('view')}
                      onClick={() => {
                        setDetailRisk(risk);
                      }}
                    />
                  ) : null}
                </Row>
                <Row style={{ borderBottomWidth: 1, color: colors.border }}></Row>
                <Text text={desc} preset="sub" />
              </Column>
            );
          })}

          {confirmable && (
            <Column>
              <Text text={t('understand_and_accept_the_risks_associated_with_this_transaction')} preset="sub" />

              <Row itemsCenter gap="sm" mb="md">
                <Text text={`${t('enter')} “${AGREEMENT_TEXT}” ${t('to_proceed')}`} preset="bold" />
              </Row>
              <Input
                preset="text"
                autoFocus={true}
                data-testid="risk-confirmation-input"
                onChange={(e) => {
                  setInputValue(e.target.value);
                }}
              />
            </Column>
          )}
        </Column>

        <Row full>
          <Button
            text={t('cancel')}
            preset="default"
            full
            onClick={(e) => {
              if (onClose) {
                onClose();
              }
            }}
          />

          {confirmable && (
            <Button
              text={t('confirm')}
              preset="danger"
              disabled={!understand}
              aria-disabled={!understand}
              data-testid="risk-confirm-button"
              full
              onClick={(e) => {
                if (onConfirm) {
                  onConfirm();
                }
              }}
            />
          )}
        </Row>
      </Column>
    </Popover>
  );
};
