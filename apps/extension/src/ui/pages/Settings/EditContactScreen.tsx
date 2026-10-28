import { IMAGE_SOURCE_MAP } from '@/shared/constant';
import { Button, Column, Content, Footer, Header, Image, Input, Layout, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { CHAINS_MAP } from '@qbit/wallet-shared';
import { useEditContactScreenLogic } from '@qbit/wallet-state';

const networkFieldStyle = {
  backgroundColor: colors.surface,
  height: 40,
  padding: '4px 12px',
  borderRadius: 0,
  border: `1px solid ${colors.border}`,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0
};

function EditContactScreen() {
  const {
    name,
    contactAddress,
    chainType,
    error,
    loading,
    handleNameChange,
    handleAddressChange,
    handleSubmit,
    handleDelete,
    onClickBack,
    address,
    t
  } = useEditContactScreenLogic();
  return (
    <Layout>
      <Header onBack={onClickBack} title={address ? t('edit_address') : t('add_address')} />
      <Content>
        <Column gap="xl" style={{ padding: `0 ${spacing.small}px ${spacing.large}px` }}>
          <Column>
            <Text text={t('name_label')} preset="regular" />
            <Input
              preset="text"
              value={name}
              onChange={handleNameChange}
              placeholder={t('enter_name')}
              style={{ color: colors.text }}
            />
          </Column>

          <Column>
            <Text text={t('address_label')} preset="regular" />
            <Input
              preset="text"
              value={contactAddress}
              onChange={handleAddressChange}
              placeholder={t('enter_address')}
              style={{ color: colors.text }}
            />
          </Column>

          <Column>
            <Text text={t('network')} preset="regular" />
            <Row
              style={{
                ...networkFieldStyle,
                display: 'flex',
                alignItems: 'center'
              }}
              itemsCenter
            >
              <Row itemsCenter>
                <Image src={IMAGE_SOURCE_MAP[CHAINS_MAP[chainType].icon]} size={16} style={{ marginRight: 8 }} />
                <Text text={CHAINS_MAP[chainType].label} color="text" />
              </Row>
            </Row>
          </Column>

          {error && (
            <Row
              style={{
                padding: spacing.small,
                backgroundColor: 'rgba(245, 84, 84, 0.1)',
                borderRadius: 0
              }}
            >
              <Text text={error} preset="regular" color="error" />
            </Row>
          )}
        </Column>
      </Content>
      <Footer style={{ padding: '16px 16px 32px 16px' }}>
        <Column full gap="lg" style={{ marginBottom: 0 }}>
          {address && (
            <Button
              text={t('delete')}
              preset="delete"
              onClick={handleDelete}
              disabled={loading}
              style={{
                minHeight: 48
              }}
              full
            />
          )}
          <Button
            text={loading ? t('saving') : t('save')}
            onClick={handleSubmit}
            disabled={loading}
            preset="primary"
            style={{
              minHeight: 48
            }}
            full
          />
        </Column>
      </Footer>
    </Layout>
  );
}

export default EditContactScreen;
