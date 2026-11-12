import { useNavigate } from 'react-router-dom';

import { Card, Column, Icon, Row, Switch, Text } from '@/ui/components';
import { fontSizes } from '@/ui/theme/font';
import { getLockTimeInfo } from '@qbit/wallet-shared';
import { useAutoLockTimeId, useBiometricUnlock, useI18n, useSecurityCardLogic } from '@qbit/wallet-state';

// The background locks on these only where the browser has the API: MV2
// builds request no `idle` permission, so they have no `chrome.idle`.
function canLockOnComputerLock(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.idle?.onStateChanged?.addListener === 'function';
}

function canLockOnWindowsClosed(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.windows?.onRemoved?.addListener === 'function' &&
    typeof chrome.windows.getAll === 'function'
  );
}

export function SecurityCard() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const autoLockTimeId = useAutoLockTimeId();
  const lockTimeConfig = getLockTimeInfo(autoLockTimeId, t);
  const { ready: biometricReady, supported: biometricSupported, enrolled: biometricEnrolled } = useBiometricUnlock();
  const { lockOnComputerLock, lockOnWindowsClosed, saving, changeLockOnComputerLock, changeLockOnWindowsClosed } =
    useSecurityCardLogic();

  const openBiometricSettings = () => {
    navigate('/settings/biometric');
  };

  return (
    <Card style={{ borderRadius: 0 }}>
      <Column fullX>
        {/* Touch ID Unlock Option */}
        {biometricReady && biometricSupported ? (
          <Row
            justifyBetween
            style={{
              cursor: 'pointer',
              marginBottom: 16
            }}
            onClick={openBiometricSettings}
            data-testid="touch-id-settings-row"
          >
            <Text text={t('touch_id_unlock')} preset="bold" size="sm" />

            <Row itemsCenter>
              <Text
                text={biometricEnrolled ? t('touch_id_status_on') : t('touch_id_status_off')}
                color="gold"
                size="sm"
              />
              <Icon icon="right" size={fontSizes.lg} color="textDim" />
            </Row>
          </Row>
        ) : null}

        {/* Auto Lock Time Option */}
        <Row
          justifyBetween
          style={{
            cursor: 'pointer'
          }}
          onClick={() => navigate('/settings/lock-time')}
        >
          <Text text={t('automatic_lock_time')} preset="bold" size="sm" />

          <Row itemsCenter>
            <Text text={lockTimeConfig.label} color="gold" size="sm" />
            <Icon icon="right" size={fontSizes.lg} color="textDim" />
          </Row>
        </Row>

        {/* Lock when the computer locks or the last window closes, once read */}
        {lockOnComputerLock !== undefined && canLockOnComputerLock() ? (
          <Row justifyBetween itemsCenter style={{ marginTop: 16 }} data-testid="lock-on-computer-lock-row">
            <Text text={t('lock_when_computer_locks')} preset="bold" size="sm" />
            <Switch checked={lockOnComputerLock} disabled={saving} onChange={changeLockOnComputerLock} />
          </Row>
        ) : null}
        {lockOnWindowsClosed !== undefined && canLockOnWindowsClosed() ? (
          <Row justifyBetween itemsCenter style={{ marginTop: 16 }} data-testid="lock-on-windows-closed-row">
            <Text text={t('lock_when_all_windows_close')} preset="bold" size="sm" />
            <Switch checked={lockOnWindowsClosed} disabled={saving} onChange={changeLockOnWindowsClosed} />
          </Row>
        ) : null}
      </Column>
    </Card>
  );
}
