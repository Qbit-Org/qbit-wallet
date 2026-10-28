import { useEffect, useState } from 'react';

import { Column, Content, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { copyToClipboard, shortAddress } from '@/ui/utils';
import { PlatformEnv, UPDATE_URL } from '@qbit/wallet-shared';
import {
  useDeveloperMode,
  useI18n,
  useNavigation,
  useSetDeveloperModeCallback,
  useTools,
  useVersionInfo
} from '@qbit/wallet-state';

export default function AboutUsScreen() {
  const nav = useNavigation();
  const versionInfo = useVersionInfo();
  const hasUpdate = versionInfo.latestVersion && versionInfo.latestVersion !== versionInfo.currentVesion;
  const { t } = useI18n();
  const tools = useTools();
  const developerMode = useDeveloperMode();
  const setDeveloperMode = useSetDeveloperModeCallback();

  const [tapCount, setTapCount] = useState(0);
  const [lastTapTime, setLastTapTime] = useState(0);

  useEffect(() => {
    if (tapCount >= 10) {
      const newMode = !developerMode;
      setDeveloperMode(newMode);
      tools.toastSuccess(newMode ? t('developer_mode_enabled') : t('developer_mode_disabled'));
      setTapCount(0);
    }
  }, [tapCount, developerMode, setDeveloperMode, tools, t]);

  const handleVersionTap = () => {
    const now = Date.now();
    const timeDiff = now - lastTapTime;

    if (timeDiff < 500) {
      setTapCount((prev) => prev + 1);
    } else {
      setTapCount(1);
    }

    setLastTapTime(now);
  };

  const copyProvenanceValue = (value: string) => {
    copyToClipboard(value).then(() => {
      tools.toastSuccess(t('copied'));
    });
  };

  const provenanceRows = [
    { label: t('core_runtime_release'), value: PlatformEnv.CORE_RELEASE_TAG, copyable: false },
    { label: t('core_commit'), value: PlatformEnv.CORE_RELEASE_COMMIT, copyable: true }
  ];

  return (
    <Layout>
      <Header onBack={() => nav.goBack()} title={t('about_qbit_wallet')} />
      <Content style={{ padding: 2 }}>
        <Column gap="lg" style={{ padding: spacing.small }}>
          {/* Logo Section */}
          <Column itemsCenter style={{ marginTop: spacing.tiny }}>
            <Icon
              icon="aboutus"
              size={82}
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                boxShadow: `0 8px 24px ${colors.shadow}`,
                boxSizing: 'border-box'
              }}
            />
          </Column>

          {/* App Name */}
          <Column itemsCenter>
            <Text text="Qbit Wallet" preset="title-bold" size="xxl" />
          </Column>

          {/* Version Info */}
          <Column itemsCenter>
            <Text
              text={`${t('version')} ${PlatformEnv.VERSION}${developerMode ? ' (Dev)' : ''}`}
              preset="sub"
              color={developerMode ? 'gold' : 'textDim'}
              onClick={handleVersionTap}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            />
          </Column>

          {/* Consensus Provenance */}
          <Column gap="sm" style={{ marginTop: spacing.tiny }} data-testid="about-provenance">
            <Text text={t('provenance')} preset="regular-bold" />
            {provenanceRows.map((row) =>
              row.value ? (
                <Row key={row.label} justifyBetween>
                  <Text text={row.label} preset="sub" color="textDim" />
                  <Text
                    text={row.copyable ? shortAddress(row.value) : row.value}
                    preset="sub"
                    onClick={row.copyable ? () => copyProvenanceValue(row.value) : undefined}
                    style={row.copyable ? { cursor: 'pointer' } : undefined}
                    data-testid={`about-provenance-${row.label}`}
                  />
                </Row>
              ) : null
            )}
          </Column>

          {/* Update Status */}
          <Column itemsCenter>
            {hasUpdate ? (
              <Row
                style={{
                  borderRadius: 0,
                  border: `1px solid ${colors.accent}`,
                  cursor: 'pointer',
                  width: 173,
                  height: 32,
                  justifyContent: 'center',
                  alignItems: 'center',
                  whiteSpace: 'nowrap',
                  gap: 0
                }}
                onClick={() => nav.navToUrl(UPDATE_URL)}
              >
                <Icon icon="arrowUp" size={14} />
                <Text
                  text={t('about_new_update')}
                  style={{ marginLeft: 3, whiteSpace: 'nowrap', color: colors.accentDark }}
                />
              </Row>
            ) : null}
          </Column>
        </Column>
      </Content>
    </Layout>
  );
}
