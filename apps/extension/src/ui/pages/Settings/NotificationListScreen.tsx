import { Column, Content, Header, Layout, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { shortDesc } from '@/ui/utils';
import { useI18n, useNavigation, useNotificationsLogic } from '@qbit/wallet-state';

export default function NotificationListScreen() {
  const { t } = useI18n();
  const nav = useNavigation();
  const { notifications, loading, unreadCount, formatTime, handleCardClick, handleReadAll, handleDeleteNotification } =
    useNotificationsLogic();

  return (
    <Layout>
      <Header
        onBack={() => {
          nav.goBack();
        }}
        title={t('notifications')}
        RightComponent={
          <Row gap="md">
            {unreadCount > 0 && <Text text={t('all_read') + ` (${unreadCount})`} onClick={handleReadAll} />}
          </Row>
        }
      />
      <Content>
        <Column gap="md">
          {loading ? (
            <Column justifyCenter itemsCenter py="xxl">
              <Text text={t('loading')} color="textDim" />
            </Column>
          ) : notifications.length === 0 ? (
            <Column justifyCenter itemsCenter py="xxl">
              <Text text={t('no_notifications')} color="textDim" />
            </Column>
          ) : (
            <Column gap="zero">
              {notifications.map((notification) => (
                <Column
                  key={notification.id}
                  style={{
                    background: colors.surface,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 0,
                    padding: 12,
                    cursor: 'pointer'
                  }}
                  mb="lg"
                  onClick={() => handleCardClick(notification)}
                >
                  <Row justifyBetween>
                    <Text
                      text={formatTime(notification.publishTime)}
                      size="xs"
                      color="textDim"
                      style={{ fontSize: 12 }}
                    />
                  </Row>
                  <Row itemsCenter>
                    {notification.readAt === undefined && (
                      <div
                        style={{
                          top: 12,
                          left: 0,
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: '#FF6B6B'
                        }}
                      />
                    )}

                    <Text text={notification.title} size="sm" style={{ fontWeight: 600, flex: 1 }} />
                  </Row>

                  <Text
                    text={shortDesc(notification.content, 120)}
                    wrap
                    size="xs"
                    color="textDim"
                    style={{ lineHeight: 1.5 }}
                  />
                </Column>
              ))}
            </Column>
          )}
        </Column>
      </Content>
    </Layout>
  );
}
