import { Search } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { ContactBookItem } from '@qbit/contact-book';
import { CHAINS_MAP } from '@qbit/wallet-shared';
import { useI18n, useWallet } from '@qbit/wallet-state';
import { ChainType } from '@qbit/wallet-types';

import { BottomModal } from '../BottomModal';
import { Card, Column, Icon, Image, Row, Text } from '../index';

interface ContactsModalProps {
  onClose: () => void;
  onSelect: (contact: ContactBookItem) => void;
  selectedNetworkFilter?: ChainType | null;
}

const formatAddress = (address: string) => {
  if (!address) return '';
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
};

export const ContactsModal: React.FC<ContactsModalProps> = ({ onClose, onSelect, selectedNetworkFilter = null }) => {
  const wallet = useWallet();
  const [contacts, setContacts] = useState<ContactBookItem[]>([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const { t } = useI18n();

  useEffect(() => {
    const loadContacts = async () => {
      setIsLoading(true);
      try {
        const list = await wallet.listContacts();
        setContacts(list);
      } catch (e) {
        console.error('Failed to load contacts', e);
      } finally {
        setIsLoading(false);
      }
    };

    loadContacts();
  }, []);

  const filteredContacts = contacts.filter(
    (contact) =>
      (contact.name.toLowerCase().includes(searchKeyword.toLowerCase()) ||
        contact.address.toLowerCase().includes(searchKeyword.toLowerCase())) &&
      (!selectedNetworkFilter || contact.chain === selectedNetworkFilter)
  );

  return (
    <BottomModal onClose={onClose}>
      <div style={{ backgroundColor: colors.surface, margin: -20, padding: 20, borderRadius: 0 }}>
        <Column gap="lg" style={{ height: '70vh' }}>
          <Row itemsCenter style={{ position: 'relative', width: '100%' }}>
            <Text text={t('address_book')} size="md" />
            <Icon
              icon="close"
              onClick={onClose}
              color="grey"
              style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)' }}
            />
          </Row>

          <div
            style={{
              width: '100%',
              height: 1,
              backgroundColor: colors.border,
              marginTop: 5,
              marginBottom: 10
            }}
          />

          <div
            style={{
              backgroundColor: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 0,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              boxSizing: 'border-box'
            }}
          >
            <Search
              size={20}
              style={{ color: colors.textDim, marginLeft: spacing.medium, display: 'flex' }}
            />
            <input
              type="text"
              placeholder={t('search_address_or_name')}
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                outline: 'none',
                color: colors.text,
                fontSize: 16,
                lineHeight: '22px',
                flex: 1,
                minWidth: 0,
                boxSizing: 'border-box',
                padding: `${spacing.extraSmall}px ${spacing.medium}px ${spacing.extraSmall}px ${spacing.extraSmall}px`
              }}
            />
          </div>

          {isLoading ? (
            <Column full justifyCenter itemsCenter style={{ flex: 1 }}>
              <Text text={t('loading_contacts')} preset="sub" textCenter />
            </Column>
          ) : filteredContacts.length === 0 ? (
            <Column full justifyCenter itemsCenter style={{ flex: 1 }}>
              <Icon
                icon="addressBookEmpty"
                size={fontSizes.iconEmpty || 50}
                style={{ marginBottom: spacing.large || 16 }}
              />
              <Text
                text={
                  contacts.length === 0
                    ? t('you_haven_t_added_any_addresses')
                    : t('no_matching_contacts_found')
                }
                preset="sub"
                textCenter
                mt="md"
              />
            </Column>
          ) : (
            <Column gap="zero" style={{ flex: 1, overflowY: 'auto' }}>
              {filteredContacts.map((contact) => (
                <Card
                  key={contact.address}
                  mt="md"
                  style={{
                    backgroundColor: colors.surface,
                    borderRadius: 0,
                    padding: '12px 16px',
                    cursor: 'pointer'
                  }}
                  onClick={() => onSelect(contact)}
                >
                  <Row full justifyBetween itemsCenter>
                    <Row itemsCenter gap="md">
                      <Image src={IMAGE_SOURCE_MAP[CHAINS_MAP[contact.chain].icon]} size={30} />
                      <Column>
                        <Text
                          text={contact.name}
                          preset="regular-bold"
                          style={{
                            maxWidth: '140px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        />
                        <Text
                          text={formatAddress(contact.address)}
                          preset="sub"
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        />
                      </Column>
                    </Row>
                  </Row>
                </Card>
              ))}
            </Column>
          )}
        </Column>
      </div>
    </BottomModal>
  );
};
