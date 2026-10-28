import { useState } from 'react';

import { Button, Checkbox, Column, Row, Text } from '@/ui/components';
import { BottomModal } from '@/ui/components/BottomModal';
import { useI18n, useNavigation } from '@qbit/wallet-state';

// The acknowledgement must survive a full popup/side-panel teardown, so it is
// cached in localStorage (the ThemeProvider pattern) rather than kept in
// component state.
export const ECOSYSTEM_WARNING_ACK_STORAGE_KEY = 'ecosystem_warning_acknowledged';

// localStorage can be denied by privacy settings or enterprise policy; treat
// that as not-yet-acknowledged so the warning still shows.
export function readEcosystemWarningAcknowledged(): boolean {
  try {
    return localStorage.getItem(ECOSYSTEM_WARNING_ACK_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistEcosystemWarningAcknowledged() {
  try {
    localStorage.setItem(ECOSYSTEM_WARNING_ACK_STORAGE_KEY, 'true');
  } catch {
    // Cache unavailable; the warning shows again on the next visit.
  }
}

// BottomModal deliberately gets no onClose: without it the overlay click does
// nothing, so the only ways out are the checkbox plus Continue, or Back to the
// wallet home screen.
export default function EcosystemWarningModal({ onContinue }: { onContinue: () => void }) {
  const { t } = useI18n();
  const nav = useNavigation();
  const [understood, setUnderstood] = useState(false);
  return (
    <BottomModal>
      <Column gap="lg" data-testid="ecosystem-warning-modal">
        <Column gap="md">
          <Text text={t('ecosystem_community_warning')} size="sm" wrap />
          <Text text={t('ecosystem_community_warning_review')} size="sm" wrap />
        </Column>
        <Checkbox
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
          data-testid="ecosystem-warning-understand"
        >
          <Text text={t('i_understand_continue')} preset="regular-bold" />
        </Checkbox>
        <Row full>
          <Button
            text={t('back')}
            preset="defaultV2"
            full
            data-testid="ecosystem-warning-back"
            onClick={() => {
              nav.navigate('MainScreen');
            }}
          />
          <Button
            text={t('continue')}
            preset="primaryV2"
            full
            disabled={!understood}
            data-testid="ecosystem-warning-continue"
            onClick={() => {
              persistEcosystemWarningAcknowledged();
              onContinue();
            }}
          />
        </Row>
      </Column>
    </BottomModal>
  );
}
