import { Column, Content, Header, Layout } from '@/ui/components';
import { AddressTypeCard } from '@/ui/components/AddressTypeCard';
import { useBackToSettingsParent } from '@/ui/utils/settingsBack';
import { useAddressTypeScreenLogic, useI18n } from '@qbit/wallet-state';

/** Settings → Advanced Settings → Address Type. */
export default function AddressTypeScreen() {
  const { t } = useI18n();
  // Advanced Settings lists this entry, so Back with nothing behind this
  // screen lands there.
  const goBack = useBackToSettingsParent('/settings/advanced');
  const { currentKeyring, items, balanceHidden, onClickItem } = useAddressTypeScreenLogic();

  return (
    <Layout>
      <Header onBack={goBack} title={t('address_type')} />
      <Content>
        <Column>
          {items.map((item, index) => {
            return (
              <AddressTypeCard
                key={index}
                label={item.name}
                address={item.address}
                assets={item.assets}
                // The account in use's holdings: shown, or hidden, as its balance is.
                asBalance
                hideBalance={balanceHidden}
                checked={item.value == currentKeyring.addressType}
                onClick={() => onClickItem(item)}
              />
            );
          })}
        </Column>
      </Content>
    </Layout>
  );
}
