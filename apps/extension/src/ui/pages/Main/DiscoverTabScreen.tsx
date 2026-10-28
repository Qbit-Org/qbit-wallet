import { useState } from 'react';

import { Column, Content, Footer, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { NavTabBar } from '@/ui/components/NavTabBar';
import { SwitchNetworkBar } from '@/ui/components/SwitchNetworkBar';
import { colors } from '@/ui/theme/colors';
import { EcosystemArtwork, EcosystemCatalogEntry, getEcosystemEntriesForChain } from '@qbit/wallet-shared';
import { useChainType, useI18n } from '@qbit/wallet-state';

import EcosystemWarningModal, { readEcosystemWarningAcknowledged } from './EcosystemWarningModal';
import { openEcosystemEntry } from './ecosystemNavigation';

const ECOSYSTEM_ARTWORK: Record<EcosystemArtwork, string> = {
  faucet: '/images/ecosystem/qbit-testnet-faucet.svg',
  'mining-pool': '/images/ecosystem/prism-testnet-pool.svg',
  'block-visualizer': '/images/ecosystem/qbit-block-visualizer.svg',
  'rich-list': '/images/ecosystem/qbit-rich-list.svg'
};

// The artwork SVGs are bare glyphs; the tile background and glyph tint are
// painted here from theme tokens so both follow the active light/dark theme
// (CSS variables cannot reach inside an <img>-loaded SVG).
function EcosystemArtworkTile({ artwork }: { artwork: EcosystemArtwork }) {
  const glyph = ECOSYSTEM_ARTWORK[artwork];
  return (
    <div
      data-testid="ecosystem-artwork-tile"
      style={{
        width: 24,
        height: 24,
        borderRadius: 4,
        backgroundColor: colors.accentWash,
        flexShrink: 0
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: colors.accentDark,
          maskImage: `url(${glyph})`,
          maskSize: 'contain',
          maskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskImage: `url(${glyph})`,
          WebkitMaskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center'
        }}
      />
    </div>
  );
}

function EcosystemAppButton({ entry }: { entry: EcosystemCatalogEntry }) {
  return (
    <button
      type="button"
      data-testid={`ecosystem-entry-${entry.id}`}
      onClick={() => {
        void openEcosystemEntry(entry.id).catch((error) => {
          console.error(`Failed to open ecosystem entry ${entry.id}`, error);
        });
      }}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        padding: 16,
        color: colors.text,
        backgroundColor: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 0,
        boxShadow: `0 8px 24px ${colors.shadow}`,
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left'
      }}
    >
      <Column gap="md" style={{ width: '100%' }}>
        <Row itemsCenter style={{ width: '100%', gap: 8 }}>
          <EcosystemArtworkTile artwork={entry.artwork} />
          <Text text={entry.title} preset="regular-bold" wrap style={{ flex: 1, minWidth: 0 }} />
          <Icon icon="link" color="accentDark" size={14} containerStyle={{ flexShrink: 0 }} />
        </Row>
        <Text text={entry.description} size="xs" color="textDim" wrap style={{ lineHeight: 1.4 }} />
      </Column>
    </button>
  );
}

export default function DiscoverTabScreen() {
  const chainType = useChainType();
  const { t } = useI18n();
  const ecosystemEntries = getEcosystemEntriesForChain(chainType);
  // Read before the first paint so the modal never flashes for users who
  // already acknowledged in an earlier popup session.
  const [warningAcknowledged, setWarningAcknowledged] = useState(() => readEcosystemWarningAcknowledged());

  return (
    <Layout>
      <Header
        type="home"
        LeftComponent={
          <Row>
            <Text preset="title-bold" text={t('dapp_center')} />
          </Row>
        }
        RightComponent={<SwitchNetworkBar />}
      />
      <Content>
        {/*
          The listings stay mounted behind the first-visit warning so the screen
          is not blank under the overlay. BottomModal neither traps focus nor
          marks the page inert, so the gated subtree is made inert (unfocusable,
          unclickable, hidden from assistive tech) until acknowledgement. React
          18 only forwards `inert` when given a string, and @types/react 18 does
          not declare it, hence the spread with an empty-string value.
        */}
        <div
          data-testid="ecosystem-listings"
          style={{ width: '100%', maxWidth: 560, alignSelf: 'center' }}
          {...(warningAcknowledged ? {} : { inert: '', 'aria-hidden': true })}
        >
          <Column gap="lg" style={{ width: '100%' }}>
            {ecosystemEntries.length > 0 ? (
              ecosystemEntries.map((entry) => <EcosystemAppButton key={entry.id} entry={entry} />)
            ) : (
              <Column
                itemsCenter
                justifyCenter
                data-testid="ecosystem-empty-state"
                style={{ minHeight: 220, width: '100%', textAlign: 'center' }}
              >
                <Icon icon="emptyBox" size={48} />
                <Text text="No ecosystem tools are listed for this network." color="textDim" textCenter wrap />
              </Column>
            )}
          </Column>
        </div>
        {!warningAcknowledged && <EcosystemWarningModal onContinue={() => setWarningAcknowledged(true)} />}
      </Content>
      <Footer px="zero" py="zero">
        <NavTabBar tab="discover" />
      </Footer>
    </Layout>
  );
}
