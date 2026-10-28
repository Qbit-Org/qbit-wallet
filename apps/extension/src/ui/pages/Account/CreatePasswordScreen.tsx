import { Button, Column, Content, Input, Layout, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { getUiType } from '@/ui/web';
import { useCreatePasswordScreenLogic, useI18n } from '@qbit/wallet-state';

type Status = '' | 'error' | 'warning' | undefined;

export default function CreatePasswordScreen() {
  const {
    strongTextRenderData,
    matchTextRenderData,
    onClickConfirm,
    disabled,
    onConfirmPasswordChange,
    onPasswordChange,
    biometricStepVisible,
    biometricEnrolling,
    onEnableBiometric,
    onSkipBiometric
    // The TouchID sheet can close the browser-action popup mid-ceremony, so
    // the onboarding step is only offered in tab/sidepanel/notification
    // surfaces; popup users enable it later via Settings → Security.
  } = useCreatePasswordScreenLogic({ offerBiometrics: !getUiType().isPop });
  const { t } = useI18n();

  const handleOnKeyUp = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!disabled && 'Enter' == e.key) {
      onClickConfirm();
    }
  };

  if (biometricStepVisible) {
    return (
      <Layout>
        <Content preset="middle">
          <Column fullX fullY>
            <Column gap="xl" style={{ marginTop: 200 }}>
              <Text text={t('enable_touch_id')} preset="title-bold" textCenter data-testid="enable-touch-id-title" />
              <Text text={t('touch_id_onboarding_desc')} preset="sub" textCenter />
              <Button
                disabled={biometricEnrolling}
                text={t('enable_touch_id')}
                preset="primary"
                onClick={onEnableBiometric}
                data-testid="enable-touch-id-button"
              />
              <Button
                disabled={biometricEnrolling}
                text={t('skip')}
                preset="default"
                onClick={onSkipBiometric}
                data-testid="skip-touch-id-button"
              />
            </Column>
          </Column>
        </Content>
      </Layout>
    );
  }

  return (
    <Layout>
      <Content preset="middle">
        <Column fullX fullY>
          <Column gap="xl" style={{ marginTop: 200 }}>
            <Text text={t('create_a_password')} preset="title-bold" textCenter data-testid="create-password-title" />
            <Text text={t('you_will_use_this_to_unlock_your_wallet')} preset="sub" textCenter />
            <Column>
              <Input
                preset="password"
                onChange={onPasswordChange}
                autoFocus={true}
                data-testid="create-password-input"
              />
              {strongTextRenderData && (
                <Column>
                  <Row>
                    <Text size="xs" text={t('password_strength')} />
                    <Text size="xs" text={strongTextRenderData.text} style={{ color: strongTextRenderData.color }} />
                  </Row>
                  {strongTextRenderData.tip ? <Text size="xs" preset="sub" text={strongTextRenderData.tip} /> : null}
                </Column>
              )}
            </Column>

            <Column>
              <Input
                preset="password"
                placeholder={t('confirm_password')}
                onChange={onConfirmPasswordChange}
                onKeyUp={(e) => handleOnKeyUp(e as any)}
                data-testid="create-password-confirm-input"
              />
              {matchTextRenderData && (
                <Row>
                  <Text size="xs" text={matchTextRenderData.text} style={{ color: colors.dangerText }} />
                </Row>
              )}
            </Column>

            <Button
              disabled={disabled}
              text={t('continue')}
              preset="primary"
              onClick={onClickConfirm}
              data-testid="create-password-continue-button"
            />
          </Column>
        </Column>
      </Content>
    </Layout>
  );
}
