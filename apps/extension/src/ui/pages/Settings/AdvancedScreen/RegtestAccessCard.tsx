import { useNavigate } from 'react-router-dom';

import { Card, Icon, Row, Text } from '@/ui/components';
import { fontSizes } from '@/ui/theme/font';
import { isRegtestLocked, useRegtestAccessStatus } from '@/ui/utils/regtestAccess';
import { useI18n } from '@qbit/wallet-state';

/**
 * Advanced-settings entry for the optional local regtest connection: the
 * label, its On/Off state and a chevron into the Local Regtest screen, in the
 * Touch ID Unlock row style. Only rendered in builds that gate the loopback
 * origin behind the optional host permission; required-permission builds
 * (E2E, local dev) have nothing to enable or disable.
 */
export function RegtestAccessCard() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { status } = useRegtestAccessStatus();

  if (!status || !status.gated) {
    return null;
  }
  const enabled = !isRegtestLocked(status);

  return (
    <Card
      style={{ borderRadius: 0, cursor: 'pointer' }}
      onClick={() => navigate('/settings/regtest-access')}
      data-testid="regtest-access-card"
    >
      <Row full justifyBetween>
        <Text text={t('local_regtest')} preset="bold" size="sm" />
        <Row itemsCenter>
          <Text
            text={enabled ? t('regtest_access_status_on') : t('regtest_access_status_off')}
            color="gold"
            size="sm"
            data-testid="regtest-access-state"
          />
          <Icon icon="right" size={fontSizes.lg} color="textDim" />
        </Row>
      </Row>
    </Card>
  );
}
