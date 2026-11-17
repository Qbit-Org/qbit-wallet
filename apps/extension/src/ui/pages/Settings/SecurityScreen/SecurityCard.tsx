import { useNavigate } from 'react-router-dom';

import { Switch } from '@/ui/components';
import { getLockTimeInfo } from '@qbit/wallet-shared';
import { useAutoLockTimeId, useBiometricUnlock, useI18n, useSecurityCardLogic } from '@qbit/wallet-state';

import { SettingsItemRow } from '../../Main/SettingsTabScreen/SettingsItemRow';

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

/**
 * The Touch ID Unlock row of the Security screen, where the browser can do
 * Touch ID; the screen lists it directly under Change Password.
 */
export function TouchIdUnlockRow() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { ready: biometricReady, supported: biometricSupported, enrolled: biometricEnrolled } = useBiometricUnlock();

  const openBiometricSettings = () => {
    navigate('/settings/biometric');
  };

  return biometricReady && biometricSupported ? (
    <SettingsItemRow
      testId="touch-id-settings-row"
      item={{
        key: 'security_touchId',
        label: t('touch_id_unlock'),
        right: true,
        icon: 'touchId',
        onClick: openBiometricSettings
      }}
      status={biometricEnrolled ? t('touch_id_status_on') : t('touch_id_status_off')}
    />
  ) : null;
}

/**
 * The lock settings of the Security screen, as rows of its list: Automatic
 * Lock Time and the two lock switches, each where the browser has the API it
 * needs and once its setting is read. The name is from the single card these
 * were in Advanced Settings.
 */
export function SecurityCard() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const autoLockTimeId = useAutoLockTimeId();
  const lockTimeConfig = getLockTimeInfo(autoLockTimeId, t);
  const { lockOnComputerLock, lockOnWindowsClosed, saving, changeLockOnComputerLock, changeLockOnWindowsClosed } =
    useSecurityCardLogic();
  // Each row's label also names its switch.
  const lockOnComputerLockLabel = t('lock_when_computer_locks');
  const lockOnWindowsClosedLabel = t('lock_when_all_windows_close');

  return (
    <>
      {/* Auto Lock Time Option */}
      <SettingsItemRow
        item={{
          key: 'security_autoLockTime',
          label: t('automatic_lock_time'),
          right: true,
          icon: 'lockTime',
          onClick: () => navigate('/settings/lock-time')
        }}
        status={lockTimeConfig.label}
      />

      {/* Lock when the computer locks or the last window closes, once read */}
      {lockOnComputerLock !== undefined && canLockOnComputerLock() ? (
        <SettingsItemRow
          testId="lock-on-computer-lock-row"
          item={{
            key: 'security_lockOnComputerLock',
            label: lockOnComputerLockLabel,
            right: false,
            icon: 'computerLock'
          }}
          control={
            <Switch
              aria-label={lockOnComputerLockLabel}
              checked={lockOnComputerLock}
              disabled={saving}
              onChange={changeLockOnComputerLock}
            />
          }
        />
      ) : null}
      {lockOnWindowsClosed !== undefined && canLockOnWindowsClosed() ? (
        <SettingsItemRow
          testId="lock-on-windows-closed-row"
          item={{
            key: 'security_lockOnWindowsClosed',
            label: lockOnWindowsClosedLabel,
            right: false,
            icon: 'windowsClose'
          }}
          control={
            <Switch
              aria-label={lockOnWindowsClosedLabel}
              checked={lockOnWindowsClosed}
              disabled={saving}
              onChange={changeLockOnWindowsClosed}
            />
          }
        />
      ) : null}
    </>
  );
}
