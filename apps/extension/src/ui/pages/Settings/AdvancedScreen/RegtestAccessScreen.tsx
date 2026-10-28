import { useState } from 'react';

import { Column, Content, Header, Icon, Layout, Loading, OptionListCard, Row, Text } from '@/ui/components';
import { isRegtestLocked, useRegtestAccessStatus } from '@/ui/utils/regtestAccess';
import { useI18n, useNavigation, useTools, useWallet } from '@qbit/wallet-state';

import RegtestAccessModal from '../RegtestAccessModal';

type RegtestAccessOption = 'enabled' | 'disabled';

const OPTIONS: readonly RegtestAccessOption[] = ['enabled', 'disabled'];

/**
 * Advanced → Local Regtest. Two options in the Automatic Lock Time style:
 * choosing Enabled runs the consent + browser-permission flow (it never
 * switches networks), choosing Disabled leaves regtest and clears the
 * acknowledgement through the background. The browser permission itself is
 * not touched (Chrome will not remove it through the API for this manifest);
 * the missing acknowledgement is what keeps regtest locked. Discoverability
 * only: the background enforces every change.
 */
export function RegtestAccessScreen() {
  const nav = useNavigation();
  const { t } = useI18n();
  const wallet = useWallet();
  const tools = useTools();
  const { status, refresh } = useRegtestAccessStatus();
  const [enableVisible, setEnableVisible] = useState(false);
  const [pending, setPending] = useState<RegtestAccessOption | null>(null);

  // An unknown status counts as disabled so a tap cannot race the first read.
  const current: RegtestAccessOption = isRegtestLocked(status) ? 'disabled' : 'enabled';
  // Builds that ship the loopback permission as required have nothing to toggle.
  const interactive = status?.gated === true && pending === null;

  const disable = async () => {
    setPending('disabled');
    try {
      // Background order: leave regtest (mainnet), then clear the
      // acknowledgement. That is the whole change; no browser prompt, no
      // permission call.
      await wallet.disableRegtestAccess();
      tools.toastSuccess(t('regtest_access_disabled'));
    } catch {
      // Nothing useful to tell the user here: the list re-reads the real
      // state below, so an unchanged tick is the report.
    } finally {
      setPending(null);
      void refresh();
    }
  };

  const select = (option: RegtestAccessOption) => {
    if (!interactive || option === current) return;
    if (option === 'enabled') {
      setEnableVisible(true);
      return;
    }
    void disable();
  };

  return (
    <Layout>
      <Header
        onBack={() => {
          nav.goBack();
        }}
        title={t('local_regtest')}
      />
      <Content>
        <Column
          style={{
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            marginTop: 16,
            paddingBottom: 16
          }}
        >
          <OptionListCard>
            {OPTIONS.map((option) => {
              const selected = option === current;
              return (
                <Row
                  key={option}
                  onClick={() => select(option)}
                  itemsCenter
                  justifyBetween
                  style={{
                    padding: '10px 16px',
                    cursor: interactive ? 'pointer' : 'default',
                    minHeight: '34px'
                  }}
                  full
                  data-testid={`regtest-access-option-${option}`}
                >
                  <Text color={selected ? 'accentDark' : 'textDim'} size="sm" text={t(option)} />
                  {pending === option ? (
                    <Loading />
                  ) : (
                    selected && pending === null && <Icon icon="checked" color="gold" size={20} />
                  )}
                </Row>
              );
            })}
          </OptionListCard>
        </Column>
        {enableVisible ? (
          <RegtestAccessModal
            onBack={() => setEnableVisible(false)}
            onEnabled={() => {
              // Enabling from Advanced settings does not switch networks.
              setEnableVisible(false);
              tools.toastSuccess(t('regtest_access_enabled'));
              void refresh();
            }}
          />
        ) : null}
      </Content>
    </Layout>
  );
}
