import { CSSProperties } from 'react';

import { Button, Card, Column, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { useQbitSendPlanEntryLogic } from '@qbit/wallet-state';

const $pausedCardStyle: CSSProperties = {
  border: `1px solid ${colors.warning_content}`,
  backgroundColor: 'rgba(244, 182, 44, 0.08)'
};

/**
 * The home screen's way back to a payment that needs several transactions
 * (#188): one compact card, so the balance and the main actions stay in
 * view in the popup.
 */
export function QbitSendPlanResumeCard() {
  const entry = useQbitSendPlanEntryLogic();
  if (!entry) return null;

  return (
    <Card
      preset="style2"
      style={{ padding: '10px 12px', ...(entry.tone === 'paused' ? $pausedCardStyle : {}) }}
      data-testid="qbit-send-plan-resume"
    >
      <Row justifyBetween itemsCenter fullX gap="md">
        <Column gap="zero" style={{ minWidth: 0, flex: 1 }}>
          <Text
            text={entry.title}
            preset="bold"
            size="sm"
            color={entry.tone === 'paused' ? 'warning' : 'text'}
            data-testid="qbit-send-plan-resume-title"
          />
          <Text text={entry.status} size="xs" color="textDim" data-testid="qbit-send-plan-resume-status" />
        </Column>
        <Button
          preset="defaultV2"
          text={entry.buttonText}
          onClick={entry.onClickOpen}
          style={{ flexShrink: 0 }}
          data-testid="qbit-send-plan-resume-button"
        />
      </Row>
    </Card>
  );
}
