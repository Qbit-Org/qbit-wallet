import { CirclePlus, Key, Pencil, Settings, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Card, Column, Content, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { RemoveWalletPopover } from '@/ui/components/RemoveWalletPopover';
import { colors } from '@/ui/theme/colors';
import { shortAddress } from '@/ui/utils';
import { KeyringType } from '@qbit/keyring-service/types';
import { WalletKeyring } from '@qbit/wallet-shared';
import {
  accountActions,
  keyringsActions,
  useAppDispatch,
  useCurrentKeyring,
  useI18n,
  useKeyrings,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';

interface MyItemProps {
  keyring: WalletKeyring;
  autoNav?: boolean;
}

const ITEM_HEIGHT = 64;
const PRIVATE_KEY_EXPORTABLE_KEYRING_TYPES = [KeyringType.HdKeyring, KeyringType.SimpleKeyring];

export function MyItem({ keyring, autoNav }: MyItemProps) {
  const navigate = useNavigate();
  const currentKeyring = useCurrentKeyring();
  const selected = currentKeyring.index === keyring.index;
  const wallet = useWallet();
  const { t } = useI18n();

  const keyrings = useKeyrings();

  const dispatch = useAppDispatch();

  const tools = useTools();

  const canExportPrivateKey = PRIVATE_KEY_EXPORTABLE_KEYRING_TYPES.includes(keyring.type as KeyringType);

  const displayAddress = useMemo(() => {
    if (!keyring?.accounts[0]) {
      return 'Invalid';
    }
    const address = keyring.accounts[0].address;
    return shortAddress(address);
  }, [keyring]);

  const [optionsVisible, setOptionsVisible] = useState(false);
  const [removeVisible, setRemoveVisible] = useState(false);

  return (
    <Card
      justifyBetween
      style={{
        height: ITEM_HEIGHT - 8,
        marginTop: 8,
        borderColor: colors.accent,
        borderWidth: selected ? 1 : 0,
        backgroundColor: selected ? colors.accentWash : colors.surface,
        marginLeft: 10,
        marginRight: 10
      }}
      data-testid={`wallet-item-${keyring.key}`}
    >
      <Row
        full
        onClick={async (e) => {
          if (!keyring.accounts[0]) {
            tools.toastError(t('invalid_wallet_please_remove_it_and_add_new_one'));
            return;
          }
          if (currentKeyring.key !== keyring.key) {
            await wallet.changeKeyring(keyring);
            dispatch(keyringsActions.setCurrent(keyring));
            const _currentAccount = await wallet.getCurrentAccount();
            dispatch(accountActions.setCurrent(_currentAccount));
          }
          if (autoNav) navigate('MainScreen');
        }}
      >
        <Column style={{ width: 20 }} selfItemsCenter>
          {selected ? (
            <Icon icon="circle-check" color="accentDark" />
          ) : (
            <Icon icon="circle" color="white_muted2" />
          )}
        </Column>

        <Column justifyCenter style={{ height: 40, gap: 4 }}>
          <Text
            text={`${keyring.alianName}`}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 200,
              lineHeight: '16px',
              height: '16px',
              display: 'block'
            }}
          />
          <Row itemsCenter gap="sm">
            <Text text={`${displayAddress}`} preset="sub" />
            {keyring.type === KeyringType.ColdWalletKeyring && (
              <div
                style={{
                  padding: '2px 8px',
                  backgroundColor: 'rgba(37, 136, 235, 0.1)',
                  borderRadius: 4,
                  border: '1px solid rgba(37, 136, 235, 0.45)',
                  fontSize: 10,
                  color: colors.blue_dark,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  height: 20,
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                {t('linked_to_cold_wallet')}
              </div>
            )}
          </Row>
        </Column>
      </Row>

      <Column relative>
        {optionsVisible && (
          <div
            style={{
              position: 'fixed',
              zIndex: 10,
              left: 0,
              right: 0,
              top: 0,
              bottom: 0
            }}
            onTouchStart={(e) => {
              setOptionsVisible(false);
            }}
            onMouseDown={(e) => {
              setOptionsVisible(false);
            }}
          ></div>
        )}

        <Icon
          onClick={async (e) => {
            setOptionsVisible(!optionsVisible);
          }}
        >
          <Settings size="1em" />
        </Icon>

        {optionsVisible && (
          <Column
            style={{
              backgroundColor: colors.surface,
              border: `1px solid ${colors.border}`,
              boxShadow: `0 12px 28px ${colors.shadow}`,
              width: 180,
              position: 'absolute',
              right: 0,
              padding: 5,
              zIndex: 10
            }}
          >
            <Column>
              <Row
                onClick={() => {
                  navigate('EditWalletNameScreen', { keyring });
                }}
              >
                <Pencil size="1em" />
                <Text text={t('edit_name')} size="sm" />
              </Row>

              {(keyring.type === KeyringType.HdKeyring || keyring.type === KeyringType.QbitHdKeyring) && (
                <Row
                  onClick={() => {
                    navigate('ExportMnemonicsScreen', { keyring });
                  }}
                >
                  <Key size="1em" />
                  <Text text={t('show_secret_recovery_phrase')} size="sm" />
                </Row>
              )}
              {canExportPrivateKey && (
                <Row
                  onClick={() => {
                    navigate('ExportPrivateKeyScreen', { account: keyring.accounts[0] });
                  }}
                >
                  <Key size="1em" />
                  <Text text={t('export_private_key')} size="sm" />
                </Row>
              )}
              <Row
                onClick={() => {
                  // TODO: Treat corrupted keyrings separately in this "last wallet" check.
                  if (keyrings.length == 1) {
                    tools.toastError(t('removing_the_last_wallet_is_not_allowed'));
                    return;
                  }
                  setRemoveVisible(true);
                  setOptionsVisible(false);
                }}
              >
                <Icon color="dangerText">
                  <Trash2 size="1em" />
                </Icon>

                <Text text={t('remove_wallet')} size="sm" color="dangerText" />
              </Row>
            </Column>
          </Column>
        )}
      </Column>

      {removeVisible && (
        <RemoveWalletPopover
          keyring={keyring}
          onClose={() => {
            setRemoveVisible(false);
          }}
        />
      )}
    </Card>
  );
}

export default function SwitchKeyringScreen() {
  const navigate = useNavigate();

  const keyrings = useKeyrings();
  const { t } = useI18n();

  const currentKeyring = useCurrentKeyring();
  const selectedItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('switch_wallet')}
        RightComponent={
          <Icon
            onClick={() => {
              navigate('AddKeyringScreen');
            }}
            data-testid="add-wallet-button"
          >
            <CirclePlus size="1em" />
          </Icon>
        }
      />
      <Content style={{ padding: 5, gap: 0 }}>
        {keyrings.map((keyring) => (
          <div
            key={keyring.key}
            ref={keyring.key === currentKeyring.key ? selectedItemRef : undefined}
            style={{ flexShrink: 0 }}
          >
            <MyItem keyring={keyring} autoNav={true} />
          </div>
        ))}
      </Content>
    </Layout>
  );
}
