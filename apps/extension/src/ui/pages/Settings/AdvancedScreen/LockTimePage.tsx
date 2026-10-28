import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Column, Content, Header, Icon, Layout, Loading, OptionListCard, Row, Text } from '@/ui/components';
import { getAutoLockTimes } from '@qbit/wallet-shared';
import {
  settingsActions,
  useAppDispatch,
  useAutoLockTimeId,
  useI18n,
  useLockTimePageLogic,
  useNavigation,
  useTools,
  useWallet
} from '@qbit/wallet-state';

export function LockTimePage() {
  const nav = useNavigation();
  const { t } = useI18n();
  const { autoLockTimeId, autoLockTimes, loading, handleSelectOption } = useLockTimePageLogic();

  return (
    <Layout>
      <Header
        onBack={() => {
          nav.goBack();
        }}
        title={t('automatic_lock_time')}
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
            {autoLockTimes.map((option, index) => {
              const check = option.id === autoLockTimeId;
              return (
                <Row
                  key={index}
                  onClick={() => handleSelectOption(option)}
                  itemsCenter
                  justifyBetween
                  style={{
                    padding: '10px 16px',
                    cursor: 'pointer',
                    minHeight: '34px'
                  }}
                  full
                >
                  <Text color={check ? 'accentDark' : 'textDim'} size="sm" text={option.label} />
                  {check && !loading && <Icon icon="checked" color="gold" size={20} />}
                  {check && loading && <Loading />}
                </Row>
              );
            })}
          </OptionListCard>
        </Column>
      </Content>
    </Layout>
  );
}
