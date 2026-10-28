import { CirclePlus, Copy, Ellipsis, Key, Pencil, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button, Card, Column, Content, Header, Icon, Layout, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { copyToClipboard, shortAddress } from '@/ui/utils';
import { KeyringType } from '@qbit/keyring-service/types';
import { Account, getAccountDerivationPath } from '@qbit/wallet-shared';
import {
  accountActions,
  useAppDispatch,
  useCurrentAccount,
  useCurrentKeyring,
  useI18n,
  useNavigation,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import { useNavigate } from '../MainRoute';

interface MyItemProps {
  account: Account;
  autoNav?: boolean;
}
const ITEM_HEIGHT = 64;
const PRIVATE_KEY_EXPORTABLE_ACCOUNT_TYPES = [KeyringType.HdKeyring, KeyringType.SimpleKeyring];
const MNEMONIC_BACKED_KEYRING_TYPES = [KeyringType.HdKeyring, KeyringType.QbitHdKeyring];
const ACCOUNT_CREATABLE_KEYRING_TYPES = [KeyringType.HdKeyring, KeyringType.QbitHdKeyring];
const DERIVED_PATH_VISIBLE_KEYRING_TYPES = [KeyringType.HdKeyring];

export function MyItem({ account, autoNav }: MyItemProps) {
  const navigate = useNavigate();
  const currentAccount = useCurrentAccount();
  const selected = currentAccount.pubkey == account.pubkey;
  const wallet = useWallet();
  const dispatch = useAppDispatch();
  const keyring = useCurrentKeyring();
  const { t } = useI18n();
  const [optionsVisible, setOptionsVisible] = useState(false);
  const tools = useTools();
  const canExportPrivateKey = PRIVATE_KEY_EXPORTABLE_ACCOUNT_TYPES.includes(account.type as KeyringType);
  const canBackupWallet = MNEMONIC_BACKED_KEYRING_TYPES.includes(keyring.type as KeyringType);
  let path = '';
  if (DERIVED_PATH_VISIBLE_KEYRING_TYPES.includes(keyring.type as KeyringType)) {
    path = ` (${getAccountDerivationPath(keyring.hdPath, account.index ?? 0, keyring.accountIndexDerivation)})`;
  }

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
      data-testid={`account-item-${account.address}`}
    >
      <Row>
        <Column style={{ width: 20 }} selfItemsCenter>
          {selected ? (
            <Icon icon="circle-check" color="accentDark" />
          ) : (
            <Icon icon="circle" color="white_muted2" />
          )}
        </Column>
        <Column
          onClick={async (e) => {
            if (currentAccount.pubkey !== account.pubkey) {
              await wallet.changeKeyring(keyring, account.index);
              const _currentAccount = await wallet.getCurrentAccount();
              dispatch(accountActions.setCurrent(_currentAccount));
            }
            if (autoNav) navigate('MainScreen');
          }}
          style={{ height: 40 }}
        >
          <Text text={shortAddress(account.alianName, 8)} ellipsis />
          <Text text={`${shortAddress(account.address)}${path}`} preset="sub" />
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
          <Ellipsis size="1em" />
        </Icon>

        {optionsVisible && (
          <Column
            style={{
              backgroundColor: colors.surface,
              border: `1px solid ${colors.border}`,
              boxShadow: `0 12px 28px ${colors.shadow}`,
              width: 160,
              position: 'absolute',
              right: 0,
              padding: 5,
              zIndex: 10
            }}
          >
            <Row
              onClick={() => {
                navigate('EditAccountNameScreen', { account });
              }}
            >
              <Pencil size="1em" />
              <Text text={t('edit_name')} size="sm" />
            </Row>
            <Row
              onClick={() => {
                copyToClipboard(account.address);
                tools.toastSuccess(t('copied'));
                setOptionsVisible(false);
              }}
            >
              <Copy size="1em" />
              <Text text={t('copy_address')} size="sm" />
            </Row>
            {/* <Row
              onClick={() => {
                copyToClipboard(account.pubkey);
                tools.toastSuccess(t('copied'));
                setOptionsVisible(false);
              }}>
              <Copy size="1em" />
              <Text text={t('copy_publickey')} size="sm" />
            </Row> */}
            {canBackupWallet && (
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
                  navigate('ExportPrivateKeyScreen', { account });
                }}
              >
                <Key size="1em" />
                <Text text={t('export_private_key')} size="sm" />
              </Row>
            )}
          </Column>
        )}
      </Column>
    </Card>
  );
}

export default function SwitchAccountScreen() {
  const nav = useNavigation();
  const keyring = useCurrentKeyring();
  const { t } = useI18n();

  const currentAccount = useCurrentAccount();
  const selectedItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const canCreateAccount = ACCOUNT_CREATABLE_KEYRING_TYPES.includes(keyring.type as KeyringType);

  return (
    <Layout>
      <Header
        onBack={() => {
          window.history.go(-1);
        }}
        title={t('switch_account')}
        RightComponent={
          canCreateAccount ? (
            <Icon
              onClick={() => {
                nav.navigate('CreateAccountScreen', {});
              }}
              data-testid="add-account-button"
            >
              <CirclePlus size="1em" />
            </Icon>
          ) : null
        }
      />
      <Content style={{ padding: 5, gap: 0 }}>
        {keyring.accounts.map((account) => (
          <div
            key={account.address}
            ref={account.pubkey === currentAccount.pubkey ? selectedItemRef : undefined}
            style={{ flexShrink: 0 }}
          >
            <MyItem account={account} autoNav={true} />
          </div>
        ))}
        {canCreateAccount && (
          <Column
            style={{
              // Sits right under the last account when the list overflows and
              // scrolls with it; pinned to the bottom edge otherwise.
              marginTop: 'auto',
              flexShrink: 0,
              paddingTop: 16,
              marginLeft: 10,
              marginRight: 10,
              marginBottom: 8
            }}
          >
            <Button
              preset="primary"
              text={t('new_account')}
              LeftAccessory={<Plus size={18} color={colors.onPrimary} />}
              onClick={() => {
                nav.navigate('CreateAccountScreen', {});
              }}
              data-testid="new-account-button"
            />
          </Column>
        )}
      </Content>
    </Layout>
  );
}
