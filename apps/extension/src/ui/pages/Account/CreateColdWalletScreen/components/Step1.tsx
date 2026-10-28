import { ScanLine } from 'lucide-react';
import { useCallback } from 'react';

import { Button, Column, Content, Header, Layout, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { useI18n, useNavigation } from '@qbit/wallet-state';

import { Step1Props } from '../types';

export default function Step1({ onNext }: Step1Props) {
  const { t } = useI18n();

  const nav = useNavigation();
  const state = nav.getRouteState<'CreateColdWalletScreen'>();

  const onBack = useCallback(() => {
    if (state && state.fromUnlock) {
      return nav.navigate('WelcomeScreen');
    }
    nav.goBack();
  }, [state]);

  return (
    <Layout style={{ backgroundColor: colors.background }}>
      <Header title={t('Create Cold Wallet')} onBack={window.history.length === 1 ? undefined : onBack} />
      <Content style={{ padding: '20px' }}>
        <Column justifyCenter itemsCenter style={{ minHeight: '400px' }}>
          {/* Main illustration */}
          <div
            style={{
              width: '120px',
              height: '120px',
              backgroundColor: colors.bg2,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '24px',
              border: `2px solid ${colors.border2}`
            }}
          >
            <ScanLine
              size={48}
              style={{
                color: colors.accentDark
              }}
            />
          </div>

          {/* Title and description */}
          <Text
            text={t('Connect Cold Wallet')}
            style={{
              fontSize: '24px',
              fontWeight: 'bold',
              color: colors.text,
              textAlign: 'center',
              marginBottom: '8px'
            }}
          />

          <Text
            text={t('Scan QR code from your mobile app to import public keys')}
            style={{
              fontSize: '14px',
              color: colors.textDim,
              textAlign: 'center',
              lineHeight: '20px',
              maxWidth: '280px',
              marginBottom: '40px'
            }}
          />

          {/* Quick steps */}
          <div
            style={{
              backgroundColor: colors.bg2,
              borderRadius: 0,
              padding: '20px',
              width: '100%',
              marginBottom: '32px',
              border: `1px solid ${colors.border2}`
            }}
          >
            <Text
              text={t('Quick Setup:')}
              style={{
                fontSize: '14px',
                fontWeight: 'bold',
                color: colors.text,
                marginBottom: '12px'
              }}
            />

            <div style={{ color: colors.text, fontSize: '13px', lineHeight: '18px' }}>
              <div style={{ marginBottom: '6px' }}>
                <span style={{ color: colors.accentDark, fontWeight: 'bold' }}>1.</span> Open mobile cold wallet app
              </div>
              <div style={{ marginBottom: '6px' }}>
                <span style={{ color: colors.accentDark, fontWeight: 'bold' }}>2.</span> Export public keys as QR
              </div>
              <div>
                <span style={{ color: colors.accentDark, fontWeight: 'bold' }}>3.</span> Scan with this extension
              </div>
            </div>
          </div>

          {/* Action button */}
          <Button
            preset="primary"
            style={{
              backgroundColor: colors.primary,
              border: 'none',
              borderRadius: 0,
              padding: '14px 32px',
              fontSize: '16px',
              fontWeight: 'bold',
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            onClick={() => {
              onNext();
            }}
          >
            <ScanLine size={18} style={{ marginRight: '8px', color: colors.onPrimary }} />
            <Text text={t('Scan QR Code')} style={{ color: colors.onPrimary, fontWeight: 'bold' }} />
          </Button>
        </Column>
      </Content>
    </Layout>
  );
}
