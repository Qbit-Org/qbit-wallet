import { useEffect } from 'react';

import { Button, Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { NavTabBar } from '@/ui/components/NavTabBar';
import { markMineTabSeen } from '@/ui/components/NavTabBar/mineTabSeen';
import { SwitchNetworkBar } from '@/ui/components/SwitchNetworkBar';
import { colors } from '@/ui/theme/colors';

import { openQbitMine } from './mineNavigation';

// Copy mirrors the hero of https://qbit.org/mine, condensed for the popup width.
const MINE_BENEFITS: ReadonlyArray<{ title: string; description: string }> = [
  { title: '3 to 60 days', description: 'Pick a ready-made plan or build your own.' },
  {
    title: 'Pay with what you hold',
    description: 'BTC, ETH, SOL, USDC, USDT and more from 35+ chains, or send from an exchange.'
  },
  { title: 'Mining in minutes', description: 'Qbit Mine rents hashrate and points it at Qbit Pool.' },
  { title: 'Paid every pool block', description: 'QBT goes straight to your Qbit address.' }
];

export default function MineTabScreen() {
  // Also covers arriving here without the tab button (e.g. a restored route).
  useEffect(() => {
    markMineTabSeen();
  }, []);

  return (
    <Layout>
      <Header
        type="home"
        LeftComponent={
          <Row>
            <Text preset="title-bold" text="Qbit Mine" />
          </Row>
        }
        RightComponent={<SwitchNetworkBar />}
      />
      <Content>
        <div data-testid="mine-hero" style={{ width: '100%', maxWidth: 560, alignSelf: 'center' }}>
          <Column
            gap="lg"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: 16,
              backgroundColor: colors.surface,
              border: `1px solid ${colors.border}`,
              boxShadow: `0 8px 24px ${colors.shadow}`
            }}
          >
            <Column itemsCenter gap="zero">
              <Icon icon="mine" color="accentDark" size={30} containerStyle={{ marginBottom: 14 }} />
              <Column gap="sm" style={{ width: '100%' }}>
                <Text
                  text="Mine QBT. No hardware required."
                  preset="bold"
                  size="md"
                  textCenter
                  wrap
                  style={{ lineHeight: 1.3 }}
                />
                <Text
                  text="Rent mining power, earn QBT every few minutes, and keep it safe in your own Qbit Wallet."
                  size="xs"
                  color="textDim"
                  textCenter
                  wrap
                  style={{ lineHeight: 1.45 }}
                />
              </Column>
            </Column>

            <Column gap="lg" data-testid="mine-benefits">
              {MINE_BENEFITS.map((benefit) => (
                <Row key={benefit.title} style={{ gap: 8, alignItems: 'flex-start' }}>
                  <Icon icon="check" color="accentDark" size={14} containerStyle={{ flexShrink: 0, marginTop: 2 }} />
                  <Column gap="sm" style={{ flex: 1, minWidth: 0 }}>
                    <Text text={benefit.title} preset="regular-bold" size="xs" wrap />
                    <Text text={benefit.description} size="xs" color="textDim" wrap style={{ lineHeight: 1.4 }} />
                  </Column>
                </Row>
              ))}
            </Column>

            <Button
              preset="primary"
              text="Open Qbit Mine"
              RightAccessory={<Icon icon="link" color="onPrimary" size={14} />}
              data-testid="open-qbit-mine"
              onClick={() => {
                void openQbitMine().catch((error) => {
                  console.error('Failed to open Qbit Mine', error);
                });
              }}
            />
          </Column>
        </div>
      </Content>
      <Footer px="zero" py="zero">
        <NavTabBar tab="mine" />
      </Footer>
    </Layout>
  );
}
