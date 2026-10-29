import { useState } from 'react';

import { Button, Column, Icon, Input, Row, Text } from '@/ui/components';
import { Popover } from '@/ui/components/Popover';
import { getRiskContentKey } from '@/ui/components/SignPsbtWithRisksPopover';
import { colors } from '@/ui/theme/colors';
import type { LocalPsbtSummary, PsbtLocalInfo, Risk } from '@qbit/wallet-shared';
import { useI18n } from '@qbit/wallet-state';

const AGREEMENT_TEXT = 'CONFIRM';

/**
 * The risk review of a quick-signed batch: every flagged transaction by
 * number with its risks, behind the typed confirmation a single PSBT's
 * review asks for. Nothing in the batch is signed until it is confirmed.
 */
export default function MultiSignRisksPopover({
  summary,
  onConfirm,
  onClose
}: {
  summary: LocalPsbtSummary;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState('');
  const understood = inputValue.toUpperCase() === AGREEMENT_TEXT;

  const flagged = summary.items.flatMap((item, index) => (item.risks.length > 0 ? [{ item, index }] : []));
  const confirmable = !flagged.some(({ item }) => item.risks.some((risk) => risk.level === 'critical'));
  const contentKey = (item: PsbtLocalInfo, risk: Risk) =>
    getRiskContentKey(risk.type, item.spendSummary?.feeAssessment);
  // Each kind of risk is explained once, after the transactions that carry it.
  const riskDescriptions = [
    ...new Set(flagged.flatMap(({ item }) => item.risks.map((risk) => contentKey(item, risk).description)))
  ];

  return (
    <Popover data-testid="multisign-risks-popover">
      <Column justifyCenter itemsCenter>
        <Icon icon="alert" color="dangerText" size={20} />
        <Text text={t('use_at_your_own_risk')} preset="title-bold" />
        <Text text={t('multisign_risks_description')} preset="sub" textCenter />

        <Column gap="md" fullX mb="md">
          {flagged.map(({ item, index }) => (
            <Column
              key={'flagged_' + index}
              style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 0 }}
              px="md"
              py="sm"
              gap="zero"
              data-testid={`multisign-risk-transaction-${index}`}
            >
              <Row justifyBetween itemsCenter>
                <Text text={`${t('transaction')} ${index + 1}`} preset="bold" />
                {item.feeRate !== '-' && <Text text={`${item.feeRate} bits/vB`} size="xs" color="textDim" />}
              </Row>
              {item.risks.map((risk, riskIndex) => (
                <Text
                  key={'risk_' + riskIndex}
                  text={t(contentKey(item, risk).title)}
                  size="xs"
                  color={risk.level === 'warning' ? 'warning' : 'dangerText'}
                />
              ))}
            </Column>
          ))}

          {riskDescriptions.map((description) => (
            <Text key={'desc_' + description} text={t(description)} preset="sub" />
          ))}

          {confirmable && (
            <Column>
              <Text text={t('understand_and_accept_the_risks_of_these_transactions')} preset="sub" />
              <Row itemsCenter gap="sm" mb="md">
                <Text text={`${t('enter')} “${AGREEMENT_TEXT}” ${t('to_proceed')}`} preset="bold" />
              </Row>
              <Input
                preset="text"
                autoFocus={true}
                data-testid="multisign-risk-confirmation-input"
                onChange={(e) => {
                  setInputValue(e.target.value);
                }}
              />
            </Column>
          )}
        </Column>

        <Row full>
          <Button text={t('cancel')} preset="default" full onClick={onClose} />
          {confirmable && (
            <Button
              text={t('confirm')}
              preset="danger"
              disabled={!understood}
              aria-disabled={!understood}
              data-testid="multisign-risk-confirm-button"
              full
              onClick={() => {
                if (understood) onConfirm();
              }}
            />
          )}
        </Row>
      </Column>
    </Popover>
  );
}
